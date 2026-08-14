import {
  ENCODED_LENGTHS,
  decodeDeviceAuthorization,
  decodePaymentCredential,
  decodeSessionCertificate,
  encodeCredentialProofBundle,
} from "@ogp/canonical-codec";
import { hashSha256 } from "@ogp/crypto";
import { validateCredentialProofBundle, type ParentState } from "@ogp/credentials";
import {
  CHALLENGE_LENGTH,
  HASH_LENGTH,
  MAX_BRANCH_DEPTH,
  PUBLIC_KEY_LENGTH,
  U64_MAX,
  NetworkId,
  OgpValidationError,
  equalBytes,
  type CredentialProofBundle,
  type DomainContext,
  type PaymentCredential,
  type ProtocolTrustContext,
} from "@ogp/shared-types";

const QR_PREFIX = "OGPQR1";
const CHALLENGE_PAYLOAD_VERSION = 1;
const CHALLENGE_ENCODED_LENGTH = 1 + 1 + HASH_LENGTH + PUBLIC_KEY_LENGTH * 3 + 8 + CHALLENGE_LENGTH;
const RECEIPT_PAYLOAD_VERSION = 1;
const RECEIPT_ENCODED_LENGTH = 1 + HASH_LENGTH + CHALLENGE_LENGTH;
const BUNDLE_HEADER_LENGTH = ENCODED_LENGTHS.sessionCertificate + ENCODED_LENGTHS.deviceAuthorization + 4;
const DEFAULT_CHUNK_BYTES = 480;
const MAX_CHUNK_BYTES = 1_024;
const MAX_FRAME_COUNT = 128;
const MAX_TRANSFER_BYTES = 64 * 1024;

export enum OfflineMessageKind {
  Challenge = 1,
  CredentialBundle = 2,
  Receipt = 3,
}

export interface MerchantChallenge extends Omit<DomainContext, "sessionId"> {
  readonly merchant: Uint8Array;
  readonly merchantDeviceKey: Uint8Array;
  readonly amount: bigint;
  readonly challenge: Uint8Array;
}

/** Transport acknowledgement only. It is not settlement or economic evidence. */
export interface TransportReceipt {
  readonly credentialHash: Uint8Array;
  readonly merchantChallenge: Uint8Array;
}

export type OfflineTrustEnvironment = Omit<ProtocolTrustContext, "sessionId">;

export interface VerifiedMerchantResponse {
  readonly credential: PaymentCredential;
  readonly finalState: ParentState;
}

export interface OfflineTransport {
  sendChallenge(value: MerchantChallenge): readonly string[];
  receiveChallenge(frames: Iterable<string>): MerchantChallenge;
  sendCredential(value: CredentialProofBundle): readonly string[];
  receiveCredential(frames: Iterable<string>): CredentialProofBundle;
  sendReceipt(value: TransportReceipt): readonly string[];
  receiveReceipt(frames: Iterable<string>): TransportReceipt;
}

export function assertChallengeEnvironment(challenge: MerchantChallenge, expected: Omit<DomainContext, "sessionId">): void {
  if (
    challenge.networkId !== expected.networkId ||
    !equalBytes(challenge.clusterGenesisHash, expected.clusterGenesisHash) ||
    !equalBytes(challenge.programId, expected.programId)
  ) {
    throw new OgpValidationError("DOMAIN_MISMATCH", "merchant challenge targets another protocol environment");
  }
}

export function validateMerchantResponse(
  environment: OfflineTrustEnvironment,
  challenge: MerchantChallenge,
  bundle: CredentialProofBundle,
): VerifiedMerchantResponse {
  assertChallengeEnvironment(challenge, environment);
  const context: ProtocolTrustContext = { ...environment, sessionId: bundle.sessionCertificate.sessionId };
  const finalState = validateCredentialProofBundle(context, bundle);
  const credential = bundle.credentials.at(-1);
  if (credential === undefined || credential.sequence !== finalState.sequence || !equalBytes(credential.newStateHash, finalState.stateHash)) {
    throw new OgpValidationError("INVALID_TRANSITION", "bundle does not end at the presented payment");
  }
  if (!equalBytes(credential.merchant, challenge.merchant) || !equalBytes(credential.merchantDeviceKey, challenge.merchantDeviceKey)) {
    throw new OgpValidationError("MERCHANT_MISMATCH", "credential targets another merchant or device");
  }
  if (credential.amount !== challenge.amount || !equalBytes(credential.merchantChallenge, challenge.challenge)) {
    throw new OgpValidationError("CHALLENGE_MISMATCH", "credential does not answer the outstanding challenge");
  }
  return { credential, finalState };
}

interface ParsedFrame {
  readonly kind: OfflineMessageKind;
  readonly payloadHash: Uint8Array;
  readonly payloadHashHex: string;
  readonly index: number;
  readonly count: number;
  readonly chunk: Uint8Array;
}

function assertExactBytes(value: Uint8Array, length: number, field: string): void {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new OgpValidationError("INVALID_LENGTH", `${field} must be exactly ${length} bytes`);
  }
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]+$/.test(value) || value.length % 2 !== 0) {
    throw new OgpValidationError("INVALID_QR_FRAME", "hash is not canonical lowercase hex");
  }
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64UrlEncode(input: Uint8Array): string {
  let output = "";
  for (let index = 0; index < input.length; index += 3) {
    const first = input[index] ?? 0;
    const second = input[index + 1] ?? 0;
    const third = input[index + 2] ?? 0;
    const packed = (first << 16) | (second << 8) | third;
    output += BASE64URL_ALPHABET[(packed >>> 18) & 63] ?? "";
    output += BASE64URL_ALPHABET[(packed >>> 12) & 63] ?? "";
    if (index + 1 < input.length) output += BASE64URL_ALPHABET[(packed >>> 6) & 63] ?? "";
    if (index + 2 < input.length) output += BASE64URL_ALPHABET[packed & 63] ?? "";
  }
  return output;
}

function base64UrlDecode(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(input) || input.length % 4 === 1) {
    throw new OgpValidationError("INVALID_QR_FRAME", "chunk is not unpadded base64url");
  }
  const output: number[] = [];
  for (let index = 0; index < input.length; index += 4) {
    const chars = input.slice(index, index + 4);
    let packed = 0;
    for (const char of chars) {
      const digit = BASE64URL_ALPHABET.indexOf(char);
      if (digit < 0) throw new OgpValidationError("INVALID_QR_FRAME", "invalid base64url digit");
      packed = (packed << 6) | digit;
    }
    packed <<= (4 - chars.length) * 6;
    output.push((packed >>> 16) & 0xff);
    if (chars.length >= 3) output.push((packed >>> 8) & 0xff);
    if (chars.length === 4) output.push(packed & 0xff);
  }
  const result = Uint8Array.from(output);
  if (base64UrlEncode(result) !== input) {
    throw new OgpValidationError("INVALID_QR_FRAME", "chunk base64url is non-canonical");
  }
  return result;
}

function writeU64LE(output: Uint8Array, offset: number, value: bigint): void {
  if (value <= 0n || value > U64_MAX) throw new OgpValidationError("INVALID_AMOUNT", "amount must be a positive u64");
  let remaining = value;
  for (let index = 0; index < 8; index += 1) {
    output[offset + index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

function readU64LE(input: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let index = 7; index >= 0; index -= 1) result = (result << 8n) | BigInt(input[offset + index] ?? 0);
  return result;
}

function writeU32LE(output: Uint8Array, offset: number, value: number): void {
  output[offset] = value & 0xff;
  output[offset + 1] = (value >>> 8) & 0xff;
  output[offset + 2] = (value >>> 16) & 0xff;
  output[offset + 3] = (value >>> 24) & 0xff;
}

function readU32LE(input: Uint8Array, offset: number): number {
  return ((input[offset] ?? 0) | ((input[offset + 1] ?? 0) << 8) | ((input[offset + 2] ?? 0) << 16) | ((input[offset + 3] ?? 0) << 24)) >>> 0;
}

function encodeChallenge(value: MerchantChallenge): Uint8Array {
  if (!Number.isInteger(value.networkId) || value.networkId < NetworkId.Localnet || value.networkId > NetworkId.MainnetBeta) {
    throw new OgpValidationError("DOMAIN_MISMATCH", "unknown network id");
  }
  for (const [field, bytes] of [
    ["clusterGenesisHash", value.clusterGenesisHash],
    ["programId", value.programId],
    ["merchant", value.merchant],
    ["merchantDeviceKey", value.merchantDeviceKey],
    ["challenge", value.challenge],
  ] as const) assertExactBytes(bytes, 32, field);
  if (value.challenge.every((byte) => byte === 0)) throw new OgpValidationError("INVALID_CHALLENGE", "all-zero challenge is forbidden");
  const output = new Uint8Array(CHALLENGE_ENCODED_LENGTH);
  output[0] = CHALLENGE_PAYLOAD_VERSION;
  output[1] = value.networkId;
  let offset = 2;
  for (const bytes of [value.clusterGenesisHash, value.programId, value.merchant, value.merchantDeviceKey]) {
    output.set(bytes, offset);
    offset += bytes.length;
  }
  writeU64LE(output, offset, value.amount);
  offset += 8;
  output.set(value.challenge, offset);
  return output;
}

function decodeChallenge(input: Uint8Array): MerchantChallenge {
  if (input.length !== CHALLENGE_ENCODED_LENGTH || input[0] !== CHALLENGE_PAYLOAD_VERSION) {
    throw new OgpValidationError("INVALID_QR_PAYLOAD", "unsupported or malformed challenge payload");
  }
  const networkId = input[1];
  if (networkId === undefined || networkId > NetworkId.MainnetBeta) throw new OgpValidationError("DOMAIN_MISMATCH", "unknown network id");
  let offset = 2;
  const take32 = (): Uint8Array => {
    const result = input.slice(offset, offset + 32);
    offset += 32;
    return result;
  };
  const clusterGenesisHash = take32();
  const programId = take32();
  const merchant = take32();
  const merchantDeviceKey = take32();
  const amount = readU64LE(input, offset);
  offset += 8;
  const challenge = take32();
  if (amount === 0n) throw new OgpValidationError("INVALID_AMOUNT", "amount must be positive");
  if (challenge.every((byte) => byte === 0)) throw new OgpValidationError("INVALID_CHALLENGE", "all-zero challenge is forbidden");
  return { networkId, clusterGenesisHash, programId, merchant, merchantDeviceKey, amount, challenge };
}

function decodeBundle(input: Uint8Array): CredentialProofBundle {
  if (input.length < BUNDLE_HEADER_LENGTH || input.length > MAX_TRANSFER_BYTES) {
    throw new OgpValidationError("INVALID_QR_PAYLOAD", "credential bundle length is invalid");
  }
  const countOffset = ENCODED_LENGTHS.sessionCertificate + ENCODED_LENGTHS.deviceAuthorization;
  const count = readU32LE(input, countOffset);
  if (count > MAX_BRANCH_DEPTH) throw new OgpValidationError("BRANCH_DEPTH_EXCEEDED", "credential bundle is too deep");
  const expectedLength = BUNDLE_HEADER_LENGTH + count * ENCODED_LENGTHS.paymentCredential;
  if (input.length !== expectedLength) throw new OgpValidationError("INVALID_QR_PAYLOAD", "credential bundle count and length differ");
  const sessionCertificate = decodeSessionCertificate(input.slice(0, ENCODED_LENGTHS.sessionCertificate));
  const authorizationStart = ENCODED_LENGTHS.sessionCertificate;
  const deviceAuthorization = decodeDeviceAuthorization(input.slice(authorizationStart, countOffset));
  const credentials = [];
  let offset = BUNDLE_HEADER_LENGTH;
  for (let index = 0; index < count; index += 1) {
    credentials.push(decodePaymentCredential(input.slice(offset, offset + ENCODED_LENGTHS.paymentCredential)));
    offset += ENCODED_LENGTHS.paymentCredential;
  }
  return { sessionCertificate, deviceAuthorization, credentials };
}

function encodeReceipt(value: TransportReceipt): Uint8Array {
  assertExactBytes(value.credentialHash, HASH_LENGTH, "credentialHash");
  assertExactBytes(value.merchantChallenge, CHALLENGE_LENGTH, "merchantChallenge");
  const output = new Uint8Array(RECEIPT_ENCODED_LENGTH);
  output[0] = RECEIPT_PAYLOAD_VERSION;
  output.set(value.credentialHash, 1);
  output.set(value.merchantChallenge, 1 + HASH_LENGTH);
  return output;
}

function decodeReceipt(input: Uint8Array): TransportReceipt {
  if (input.length !== RECEIPT_ENCODED_LENGTH || input[0] !== RECEIPT_PAYLOAD_VERSION) {
    throw new OgpValidationError("INVALID_QR_PAYLOAD", "unsupported or malformed receipt payload");
  }
  return { credentialHash: input.slice(1, 1 + HASH_LENGTH), merchantChallenge: input.slice(1 + HASH_LENGTH) };
}

function parseFrame(frame: string): ParsedFrame {
  const fields = frame.split(".");
  if (fields.length !== 6 || fields[0] !== QR_PREFIX) throw new OgpValidationError("INVALID_QR_FRAME", "unknown QR frame prefix");
  const [, kindText, hashText, indexText, countText, chunkText] = fields;
  if (kindText === undefined || hashText === undefined || indexText === undefined || countText === undefined || chunkText === undefined) {
    throw new OgpValidationError("INVALID_QR_FRAME", "QR frame fields are missing");
  }
  if (!/^[1-3]$/.test(kindText) || !/^(0|[1-9][0-9]*)$/.test(indexText) || !/^[1-9][0-9]*$/.test(countText)) {
    throw new OgpValidationError("INVALID_QR_FRAME", "QR frame numeric fields are non-canonical");
  }
  const kind = Number(kindText) as OfflineMessageKind;
  const index = Number(indexText);
  const count = Number(countText);
  if (count > MAX_FRAME_COUNT || index >= count) throw new OgpValidationError("INVALID_QR_FRAME", "QR frame index or count is invalid");
  const payloadHash = hexToBytes(hashText);
  assertExactBytes(payloadHash, HASH_LENGTH, "payloadHash");
  return { kind, payloadHash, payloadHashHex: hashText, index, count, chunk: base64UrlDecode(chunkText) };
}

export class QRTransport implements OfflineTransport {
  public constructor(private readonly chunkBytes = DEFAULT_CHUNK_BYTES) {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 64 || chunkBytes > MAX_CHUNK_BYTES) {
      throw new OgpValidationError("INVALID_QR_CONFIG", `chunkBytes must be between 64 and ${MAX_CHUNK_BYTES}`);
    }
  }

  public sendChallenge(value: MerchantChallenge): readonly string[] { return this.frame(OfflineMessageKind.Challenge, encodeChallenge(value)); }
  public receiveChallenge(frames: Iterable<string>): MerchantChallenge { return decodeChallenge(this.assemble(OfflineMessageKind.Challenge, frames)); }
  public sendCredential(value: CredentialProofBundle): readonly string[] { return this.frame(OfflineMessageKind.CredentialBundle, encodeCredentialProofBundle(value)); }
  public receiveCredential(frames: Iterable<string>): CredentialProofBundle { return decodeBundle(this.assemble(OfflineMessageKind.CredentialBundle, frames)); }
  public sendReceipt(value: TransportReceipt): readonly string[] { return this.frame(OfflineMessageKind.Receipt, encodeReceipt(value)); }
  public receiveReceipt(frames: Iterable<string>): TransportReceipt { return decodeReceipt(this.assemble(OfflineMessageKind.Receipt, frames)); }

  private frame(kind: OfflineMessageKind, payload: Uint8Array): readonly string[] {
    if (payload.length === 0 || payload.length > MAX_TRANSFER_BYTES) throw new OgpValidationError("INVALID_QR_PAYLOAD", "payload length is invalid");
    const hashHex = bytesToHex(hashSha256(payload));
    const count = Math.ceil(payload.length / this.chunkBytes);
    if (count > MAX_FRAME_COUNT) throw new OgpValidationError("INVALID_QR_PAYLOAD", "payload requires too many frames");
    const frames: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const chunk = payload.slice(index * this.chunkBytes, Math.min(payload.length, (index + 1) * this.chunkBytes));
      frames.push(`${QR_PREFIX}.${kind}.${hashHex}.${index}.${count}.${base64UrlEncode(chunk)}`);
    }
    return frames;
  }

  private assemble(expectedKind: OfflineMessageKind, frames: Iterable<string>): Uint8Array {
    const chunks = new Map<number, Uint8Array>();
    let transfer: ParsedFrame | undefined;
    for (const raw of frames) {
      const frame = parseFrame(raw);
      if (frame.kind !== expectedKind) throw new OgpValidationError("INVALID_QR_FRAME", "unexpected message kind");
      if (transfer !== undefined && (frame.payloadHashHex !== transfer.payloadHashHex || frame.count !== transfer.count)) {
        throw new OgpValidationError("MIXED_QR_TRANSFER", "frames belong to different transfers");
      }
      const existing = chunks.get(frame.index);
      if (existing !== undefined && !equalBytes(existing, frame.chunk)) throw new OgpValidationError("CONFLICTING_QR_FRAME", "duplicate index contains different bytes");
      chunks.set(frame.index, frame.chunk);
      transfer ??= frame;
    }
    if (transfer === undefined || chunks.size !== transfer.count) throw new OgpValidationError("INCOMPLETE_QR_TRANSFER", "not all QR frames were received");
    const totalLength = [...chunks.values()].reduce((sum, chunk) => sum + chunk.length, 0);
    if (totalLength > MAX_TRANSFER_BYTES) throw new OgpValidationError("INVALID_QR_PAYLOAD", "assembled payload is too large");
    const payload = new Uint8Array(totalLength);
    let offset = 0;
    for (let index = 0; index < transfer.count; index += 1) {
      const chunk = chunks.get(index);
      if (chunk === undefined) throw new OgpValidationError("INCOMPLETE_QR_TRANSFER", "a QR frame is missing");
      payload.set(chunk, offset);
      offset += chunk.length;
    }
    if (!equalBytes(hashSha256(payload), transfer.payloadHash)) throw new OgpValidationError("QR_INTEGRITY_FAILURE", "assembled payload hash differs");
    return payload;
  }
}
