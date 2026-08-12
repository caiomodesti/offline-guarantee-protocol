import { describe, expect, it } from "vitest";
import {
  CLAIM_ACCOUNT_SIZE,
  CLAIM_DISCRIMINATOR,
  STATE_EDGE_RECORD_ACCOUNT_SIZE,
  STATE_EDGE_RECORD_DISCRIMINATOR,
  decodeClaim,
  decodeStateEdgeRecord,
} from "@ogp/protocol-sdk";

describe("protocol account decoders", () => {
  it("decodes the fixed Claim layout", () => {
    const data = new Uint8Array(CLAIM_ACCOUNT_SIZE);
    data.set(CLAIM_DISCRIMINATOR);
    const view = new DataView(data.buffer);
    view.setBigUint64(104, 25n, true);
    view.setUint32(112, 7, true);
    view.setBigUint64(180, 99n, true);
    view.setUint8(188, 4);
    view.setUint8(189, 1);
    view.setUint8(206, 254);

    expect(decodeClaim(data)).toMatchObject({
      amount: 25n,
      sequence: 7,
      submittedSlot: 99n,
      status: "rejected",
      rejectionReason: "duplicateStateEdge",
      bump: 254,
    });
  });

  it("decodes the fixed StateEdgeRecord layout", () => {
    const data = new Uint8Array(STATE_EDGE_RECORD_ACCOUNT_SIZE);
    data.set(STATE_EDGE_RECORD_DISCRIMINATOR);
    const view = new DataView(data.buffer);
    view.setUint32(72, 3, true);
    view.setBigUint64(140, 40n, true);
    view.setUint32(196, 2, true);
    view.setUint8(224, 253);

    expect(decodeStateEdgeRecord(data)).toMatchObject({
      sequence: 3,
      amount: 40n,
      wrapperCount: 2,
      bump: 253,
    });
  });

  it("rejects the wrong length or discriminator", () => {
    expect(() => decodeClaim(new Uint8Array(CLAIM_ACCOUNT_SIZE - 1))).toThrow(/exactly/);
    expect(() => decodeStateEdgeRecord(new Uint8Array(STATE_EDGE_RECORD_ACCOUNT_SIZE))).toThrow(/discriminator/);
  });
});
