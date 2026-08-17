import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { RelayerError } from "./claim-relayer.js";

const MAX_BODY_BYTES = 8_192;
const DEFAULT_SUBMISSION_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;

export interface ClaimSubmitter {
  readonly submit: (input: unknown) => Promise<{ readonly transactionSignature: string }>;
}

function respond(response: ServerResponse, status: number, body: Readonly<Record<string, unknown>>): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(encoded), "cache-control": "no-store" });
  response.end(encoded);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared < 0 || declared > MAX_BODY_BYTES) throw new RelayerError("PAYLOAD_TOO_LARGE", "request excede 8192 bytes", 413);
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += bytes.length;
    if (received > MAX_BODY_BYTES) throw new RelayerError("PAYLOAD_TOO_LARGE", "request excede 8192 bytes", 413);
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RelayerError("INVALID_JSON", "corpo JSON inválido");
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RelayerError("SUBMISSION_TIMEOUT", "tempo limite da submissão excedido", 504)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface RelayerServerOptions {
  readonly submissionTimeoutMs?: number;
  readonly maxConcurrent?: number;
  readonly rateLimitPerMinute?: number;
}

export function createRelayerServer(submitter: ClaimSubmitter, options: RelayerServerOptions = {}) {
  const submissionTimeoutMs = options.submissionTimeoutMs ?? DEFAULT_SUBMISSION_TIMEOUT_MS;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const rateLimitPerMinute = options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  if (submissionTimeoutMs <= 0 || maxConcurrent <= 0 || rateLimitPerMinute <= 0) throw new Error("relayer server limits must be positive");
  let concurrent = 0;
  const clients = new Map<string, { count: number; windowStartedAt: number }>();
  const server = createServer(async (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    if (request.method === "GET" && request.url === "/healthz") {
      respond(response, 200, { status: "ok" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/claims") {
      respond(response, 404, { code: "NOT_FOUND", error: "rota inexistente" });
      return;
    }
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      respond(response, 415, { code: "UNSUPPORTED_MEDIA_TYPE", error: "content-type deve ser application/json" });
      return;
    }
    const client = request.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const observed = clients.get(client);
    const rate = observed === undefined || now - observed.windowStartedAt >= 60_000
      ? { count: 1, windowStartedAt: now }
      : { count: observed.count + 1, windowStartedAt: observed.windowStartedAt };
    clients.set(client, rate);
    if (rate.count > rateLimitPerMinute) {
      respond(response, 429, { code: "RATE_LIMITED", error: "limite temporário de submissões excedido" });
      return;
    }
    if (concurrent >= maxConcurrent) {
      respond(response, 503, { code: "RELAYER_BUSY", error: "relayer temporariamente ocupado" });
      return;
    }
    concurrent += 1;
    try {
      const input = await readJson(request);
      const result = await withTimeout(submitter.submit(input), submissionTimeoutMs);
      respond(response, 200, result);
    } catch (error) {
      const known = error instanceof RelayerError ? error : new RelayerError("INTERNAL_ERROR", "falha interna do relayer", 500);
      respond(response, known.httpStatus, { code: known.code, error: known.message });
    } finally {
      concurrent -= 1;
    }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
