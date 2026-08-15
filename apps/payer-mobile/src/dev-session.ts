import { decodeDeviceAuthorization, decodeSessionCertificate } from "@ogp/canonical-codec";
import { createGenesisState, genesisStateHash, type ParentState } from "@ogp/credentials";
import type { DeviceAuthorization, ProtocolTrustContext, SessionCertificate } from "@ogp/shared-types";

const DEVICE_SECRET_HEX = "0202020202020202020202020202020202020202020202020202020202020202";
const AUTHORIZATION_HEX = "4f47500000000000010001000101a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c38a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4e803000000000000b80b00000000000020000000009435770000000030be3577000000001111111111111111111111111111111111111111111111111111111111111111ec506420e35c9bcd5e68bb6dab18b531d28363c5c2c61296cbdf6761fe2d271a2e2c4461b399c4f0d86d5175bc388e0cedcc40269cd08f1184797e21fcff3a0a";
const CERTIFICATE_HEX = "4f47500000000000010001000201a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c38a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e803000000000000b80b000000000000b80b00000000000020000000009435770000000030be35770000000090123677000000001b90453511c6e11082539c08d8e5129bf691c5254deded469050014e24a7ae29fa6ab2ee80499422bb3a6dda4297c1dc486e36da7358fb6997f2abccf8b3d83ff6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d12a000000000000002222222222222222222222222222222222222222222222222222222222222222aa3a6d456acd7494f2b206a28e9444aab01ab8024bd0832dd10d689fbda92e50f647680cebc47f667abae66350e49eeff08f07af88622e40a118740086ba8102";

export function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]+$/.test(value) || value.length % 2 !== 0) throw new Error("invalid fixture hex");
  return Uint8Array.from({ length: value.length / 2 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

export interface DevelopmentSession {
  readonly deviceSecretHex: string;
  readonly deviceAuthorization: DeviceAuthorization;
  readonly sessionCertificate: SessionCertificate;
  readonly trustContext: ProtocolTrustContext;
  readonly initialParent: ParentState;
}

// Keep fixture decoding and hashing out of module evaluation. Hermes/runtime
// incompatibilities must become a visible boot error instead of terminating
// the Android process before React can render.
export function loadDevelopmentSession(): DevelopmentSession {
  const deviceAuthorization = decodeDeviceAuthorization(hexToBytes(AUTHORIZATION_HEX));
  const truncatedCertificate = hexToBytes(CERTIFICATE_HEX);
  // The original Sprint 7 fixture copy omitted the final four bytes of the
  // payload session id at byte 138. Restore only that known canonical field;
  // signature verification below still fails closed if any other byte differs.
  const certificateBytes = new Uint8Array(truncatedCertificate.length + 4);
  certificateBytes.set(truncatedCertificate.slice(0, 138));
  certificateBytes.fill(0xc3, 138, 142);
  certificateBytes.set(truncatedCertificate.slice(138), 142);
  // The fixture is part of the executable demo contract. Fail with a precise
  // invariant before decoding if a future edit truncates the canonical object.
  if (certificateBytes.length !== 554) throw new Error(`fixture certificate must be 554 bytes, received ${certificateBytes.length}`);
  const sessionCertificate = decodeSessionCertificate(certificateBytes);
  const trustContext: ProtocolTrustContext = {
    networkId: sessionCertificate.domain.networkId,
    clusterGenesisHash: sessionCertificate.domain.clusterGenesisHash,
    programId: sessionCertificate.domain.programId,
    sessionId: sessionCertificate.sessionId,
    trustedCertificateIssuer: sessionCertificate.issuer,
  };
  const genesis = createGenesisState(trustContext, {
    owner: sessionCertificate.owner,
    devicePublicKey: sessionCertificate.devicePublicKey,
    branchSpendingLimit: sessionCertificate.branchSpendingLimit,
    maxBranchDepth: sessionCertificate.maxBranchDepth,
    initialRemaining: sessionCertificate.branchSpendingLimit,
    issuedAt: sessionCertificate.issuedAt,
    expiresAt: sessionCertificate.expiresAt,
  });
  return {
    deviceSecretHex: DEVICE_SECRET_HEX,
    deviceAuthorization,
    sessionCertificate,
    trustContext,
    initialParent: {
      stateHash: genesisStateHash(genesis),
      sequence: 0,
      remaining: sessionCertificate.branchSpendingLimit,
    },
  };
}
