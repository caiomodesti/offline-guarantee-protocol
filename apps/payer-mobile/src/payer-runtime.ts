import type { ParentState } from "@ogp/credentials";
import type { DeviceAuthorization, PaymentCredential, ProtocolTrustContext, SessionCertificate } from "@ogp/shared-types";

export interface PayerSessionRuntime {
  readonly deviceSecretHex: string;
  readonly deviceAuthorization: DeviceAuthorization;
  readonly sessionCertificate: SessionCertificate;
  readonly trustContext: ProtocolTrustContext;
  readonly initialParent: ParentState;
}

export interface RestoredPayerSession {
  readonly runtime: PayerSessionRuntime;
  readonly parent: ParentState;
  readonly credentials: readonly PaymentCredential[];
  readonly outgoingFrames: readonly string[];
  readonly pendingDelivery: boolean;
}

export function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]+$/.test(value) || value.length % 2 !== 0) throw new Error("hexadecimal inválido");
  return Uint8Array.from({ length: value.length / 2 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

export function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
