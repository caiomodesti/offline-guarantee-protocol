import { decodeUserProfile } from "@ogp/protocol-sdk";
import { authoritativeRecoveryFromAccounts, type RawProgramAccount } from "./onchain-recovery.js";
import type { PayerRecoveryChainPort } from "./onchain-recovery-controller.js";
import { hexToBytes } from "./payer-runtime.js";

export interface ConfirmedProgramAccount {
  readonly contextSlot: bigint;
  readonly account: RawProgramAccount;
}

export interface ConfirmedProgramAccountReader {
  /** Reads with confirmed commitment and honors minContextSlot when provided. */
  readonly getConfirmedAccount: (address: Uint8Array, minContextSlot: bigint | null) => Promise<ConfirmedProgramAccount | null>;
}

export interface RecoveryAddressResolver {
  readonly profileAddress: (owner: Uint8Array) => Uint8Array;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isZero(value: Uint8Array): boolean {
  return value.every((byte) => byte === 0);
}

function assertEnvelope(value: ConfirmedProgramAccount, address: Uint8Array, programId: Uint8Array, name: string): void {
  if (value.contextSlot < 0n) throw new Error(`${name} retornou slot confirmado inválido`);
  if (!equalBytes(value.account.address, address)) throw new Error(`${name} retornou endereço diferente do solicitado`);
  if (!equalBytes(value.account.ownerProgramId, programId)) throw new Error(`${name} não pertence ao programa configurado`);
}

/** Builds the chain port used by the recovery controller from confirmed RPC account reads. */
export function createConfirmedRecoveryPort(
  expectedProgramId: Uint8Array,
  resolver: RecoveryAddressResolver,
  reader: ConfirmedProgramAccountReader,
): PayerRecoveryChainPort {
  if (expectedProgramId.length !== 32) throw new Error("program ID configurado deve conter 32 bytes");
  return {
    fetchConfirmedRecovery: async (ownerHex) => {
      const owner = hexToBytes(ownerHex);
      if (owner.length !== 32) throw new Error("owner deve conter 32 bytes");
      const profileAddress = resolver.profileAddress(owner);
      if (profileAddress.length !== 32) throw new Error("profile PDA deve conter 32 bytes");
      const profileEnvelope = await reader.getConfirmedAccount(profileAddress, null);
      if (profileEnvelope === null) throw new Error("UserProfile confirmado não encontrado");
      assertEnvelope(profileEnvelope, profileAddress, expectedProgramId, "UserProfile");
      const profile = decodeUserProfile(profileEnvelope.account.data);

      let sessionEnvelope: ConfirmedProgramAccount | null = null;
      if (!isZero(profile.activeSession)) {
        sessionEnvelope = await reader.getConfirmedAccount(profile.activeSession, profileEnvelope.contextSlot);
        if (sessionEnvelope === null) throw new Error("OfflineSession ativo confirmado não encontrado");
        assertEnvelope(sessionEnvelope, profile.activeSession, expectedProgramId, "OfflineSession");
        if (sessionEnvelope.contextSlot < profileEnvelope.contextSlot) throw new Error("OfflineSession retornou contexto anterior ao UserProfile");
      }

      return authoritativeRecoveryFromAccounts({
        confirmed: true,
        expectedProgramId,
        expectedProfileAddress: profileAddress,
        expectedOwner: owner,
        profile: profileEnvelope.account,
        session: sessionEnvelope?.account ?? null,
      });
    },
  };
}
