import * as ed25519 from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";

ed25519.hashes.sha512 = sha512;

export function hashSha256(message: Uint8Array): Uint8Array {
  return sha256(message);
}

export function derivePublicKey(secretKey: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(secretKey);
}

export function signEd25519(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, secretKey);
}

export function verifyEd25519(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

export function randomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length <= 0) throw new RangeError("length must be a positive safe integer");
  const result = new Uint8Array(length);
  const cryptoProvider = globalThis.crypto;
  if (cryptoProvider === undefined) throw new Error("OS CSPRNG is unavailable");
  cryptoProvider.getRandomValues(result);
  return result;
}

export function generateSecretKey(): Uint8Array {
  return randomBytes(32);
}

export function generateChallenge(): Uint8Array {
  let challenge = randomBytes(32);
  while (challenge.every((value) => value === 0)) challenge = randomBytes(32);
  return challenge;
}

