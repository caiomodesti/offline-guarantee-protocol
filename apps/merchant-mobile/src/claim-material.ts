import { credentialHash, validateCredentialProofBundle } from "@ogp/credentials";
import { createClaimSubmissionMaterial, type ClaimSubmissionMaterial } from "@ogp/protocol-sdk";
import { equalBytes } from "@ogp/shared-types";
import { QRTransport, type OfflineTrustEnvironment } from "@ogp/transports";
import type { StoredClaim } from "./claim-history";

export interface StoredClaimTrust extends OfflineTrustEnvironment {
  readonly merchant: Uint8Array;
  readonly merchantDeviceKey: Uint8Array;
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Revalidates durable QR evidence and derives the exact on-chain claim bytes.
 * Nothing is reconstructed from editable display metadata.
 */
export function materializeStoredClaim(claim: StoredClaim, trust: StoredClaimTrust): ClaimSubmissionMaterial {
  const bundle = new QRTransport().receiveCredential(claim.frames);
  const credential = bundle.credentials.at(-1);
  if (credential === undefined) throw new Error("prova armazenada não contém credencial");
  validateCredentialProofBundle({ ...trust, sessionId: bundle.sessionCertificate.sessionId }, bundle);

  if (!equalBytes(credential.merchant, trust.merchant)) throw new Error("merchant da prova armazenada divergente");
  if (!equalBytes(credential.merchantDeviceKey, trust.merchantDeviceKey)) throw new Error("dispositivo merchant da prova armazenada divergente");
  if (bytesToHex(credential.sessionId) !== claim.sessionId) throw new Error("sessão da prova armazenada divergente");
  if (credential.amount.toString() !== claim.amount) throw new Error("valor da prova armazenada divergente");

  const material = createClaimSubmissionMaterial(credential);
  if (bytesToHex(credentialHash(credential)) !== claim.credentialHash) throw new Error("credential hash da prova armazenada divergente");
  if (bytesToHex(material.credentialHash) !== claim.credentialHash) throw new Error("claim material não corresponde à prova armazenada");
  return material;
}
