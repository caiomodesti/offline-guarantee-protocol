import { describe, expect, it, vi } from "vitest";
import {
  OFFLINE_SESSION_ACCOUNT_SIZE,
  OFFLINE_SESSION_DISCRIMINATOR,
  USER_PROFILE_ACCOUNT_SIZE,
  USER_PROFILE_DISCRIMINATOR,
} from "@ogp/protocol-sdk";
import { createConfirmedRecoveryPort, type ConfirmedProgramAccountReader } from "../../apps/payer-mobile/src/confirmed-recovery-port.js";
import type { RawProgramAccount } from "../../apps/payer-mobile/src/onchain-recovery.js";

const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);

function profileData(activeSession: Uint8Array): Uint8Array {
  const data = new Uint8Array(USER_PROFILE_ACCOUNT_SIZE);
  data.set(USER_PROFILE_DISCRIMINATOR);
  data.set(bytes(0x22), 8);
  data[105] = 1;
  data.set(activeSession, 130);
  return data;
}

function sessionData(): Uint8Array {
  const data = new Uint8Array(OFFLINE_SESSION_ACCOUNT_SIZE);
  data.set(OFFLINE_SESSION_DISCRIMINATOR);
  data.set(bytes(0x44), 8);
  data.set(bytes(0x22), 40);
  data.set(bytes(0x55), 72);
  return data;
}

function account(address: Uint8Array, ownerProgramId: Uint8Array, data: Uint8Array): RawProgramAccount {
  return { address, ownerProgramId, data };
}

describe("confirmed recovery chain port", () => {
  const program = bytes(0x11);
  const owner = bytes(0x22);
  const profile = bytes(0x33);
  const session = bytes(0x66);

  it("reads profile then active session at a non-stale confirmed context", async () => {
    const reader: ConfirmedProgramAccountReader = {
      getConfirmedAccount: vi.fn(async (address, minContextSlot) => {
        if (address.every((value, index) => value === profile[index])) {
          expect(minContextSlot).toBeNull();
          return { contextSlot: 40n, account: account(profile, program, profileData(session)) };
        }
        expect(minContextSlot).toBe(40n);
        return { contextSlot: 41n, account: account(session, program, sessionData()) };
      }),
    };
    const port = createConfirmedRecoveryPort(program, { profileAddress: () => profile }, reader);
    const result = await port.fetchConfirmedRecovery("22".repeat(32));
    expect(result).toMatchObject({ confirmed: true, activeSessionAccount: "66".repeat(32), sessionId: "44".repeat(32) });
    expect(reader.getConfirmedAccount).toHaveBeenCalledTimes(2);
  });

  it("does not invent a session for a confirmed free profile", async () => {
    const reader: ConfirmedProgramAccountReader = {
      getConfirmedAccount: vi.fn(async () => ({ contextSlot: 40n, account: account(profile, program, profileData(bytes(0))) })),
    };
    const result = await createConfirmedRecoveryPort(program, { profileAddress: () => profile }, reader).fetchConfirmedRecovery("22".repeat(32));
    expect(result.activeSessionAccount).toBeNull();
    expect(reader.getConfirmedAccount).toHaveBeenCalledTimes(1);
  });

  it("rejects missing, substituted, and stale account envelopes", async () => {
    const missing: ConfirmedProgramAccountReader = { getConfirmedAccount: vi.fn(async () => null) };
    await expect(createConfirmedRecoveryPort(program, { profileAddress: () => profile }, missing).fetchConfirmedRecovery("22".repeat(32)))
      .rejects.toThrow(/UserProfile confirmado não encontrado/);

    const substituted: ConfirmedProgramAccountReader = {
      getConfirmedAccount: vi.fn(async () => ({ contextSlot: 40n, account: account(profile, bytes(0x99), profileData(bytes(0))) })),
    };
    await expect(createConfirmedRecoveryPort(program, { profileAddress: () => profile }, substituted).fetchConfirmedRecovery("22".repeat(32)))
      .rejects.toThrow(/não pertence/);

    const stale: ConfirmedProgramAccountReader = {
      getConfirmedAccount: vi.fn(async (address) => address.every((value, index) => value === profile[index])
        ? { contextSlot: 40n, account: account(profile, program, profileData(session)) }
        : { contextSlot: 39n, account: account(session, program, sessionData()) }),
    };
    await expect(createConfirmedRecoveryPort(program, { profileAddress: () => profile }, stale).fetchConfirmedRecovery("22".repeat(32)))
      .rejects.toThrow(/contexto anterior/);
  });
});
