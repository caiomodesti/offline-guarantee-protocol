import { readFile } from "node:fs/promises";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { NetworkId } from "@ogp/shared-types";
import { SolanaClaimRelayer } from "./claim-relayer.js";
import { createRelayerServer } from "./server.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

function exactHex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("OGP_CLUSTER_GENESIS_HASH must be 32 lowercase hexadecimal bytes");
  return Uint8Array.from(Buffer.from(value, "hex"));
}

async function loadKeypair(path: string): Promise<Keypair> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error("OGP_RELAYER_KEYPAIR_PATH must point to a Solana 64-byte keypair JSON file");
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

const rpcUrl = required("OGP_RPC_URL");
const parsedRpc = new URL(rpcUrl);
const loopback = parsedRpc.hostname === "localhost" || parsedRpc.hostname === "127.0.0.1" || parsedRpc.hostname === "::1";
if (parsedRpc.protocol !== "https:" && !(loopback && parsedRpc.protocol === "http:")) throw new Error("OGP_RPC_URL must use HTTPS or loopback HTTP");
if (parsedRpc.username !== "" || parsedRpc.password !== "") throw new Error("OGP_RPC_URL must not embed credentials");
const programId = new PublicKey(required("OGP_PROGRAM_ID"));
const networkId = Number(required("OGP_NETWORK_ID"));
if (!Number.isInteger(networkId) || networkId < NetworkId.Localnet || networkId > NetworkId.MainnetBeta) throw new Error("OGP_NETWORK_ID is invalid");
const clusterGenesisHash = exactHex(required("OGP_CLUSTER_GENESIS_HASH"));
const relayerKeypair = await loadKeypair(required("OGP_RELAYER_KEYPAIR_PATH"));
const connection = new Connection(rpcUrl, "confirmed");
const observedGenesis = new PublicKey(await connection.getGenesisHash()).toBytes();
if (!Buffer.from(observedGenesis).equals(Buffer.from(clusterGenesisHash))) throw new Error("configured RPC genesis hash mismatch");

const relayer = new SolanaClaimRelayer({ networkId, clusterGenesisHash, programId, relayer: relayerKeypair, connection });
const host = process.env.OGP_RELAYER_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.OGP_RELAYER_PORT ?? "8787");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("OGP_RELAYER_PORT is invalid");
createRelayerServer(relayer).listen(port, host, () => {
  console.log(`OGP claim relayer listening on http://${host}:${port}; relayer=${relayerKeypair.publicKey.toBase58()}`);
});
