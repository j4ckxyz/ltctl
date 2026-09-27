import { describe, expect, test } from "bun:test";
import { decodeMessage, encodeRequest, frameReports, ProtoFields, ProtoWriter, Reassembler } from "../src/protocol";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex").replace(/(..)(?!$)/g, "$1 ");
const bytes = (s: string) => Uint8Array.from(s.split(" ").map((x) => parseInt(x, 16)));

describe("requests (byte-exact against messages a Mustang LT25 answered)", () => {
  test.each([
    [{ type: "heartbeat" } as const, "08 00 ca 0c 02 08 01"],
    [{ type: "connectionStatus" } as const, "08 00 d2 0c 02 08 01"],
    [{ type: "firmwareVersion" } as const, "08 00 b2 06 02 08 01"],
    [{ type: "modalStatus", context: 0, state: 0 } as const, "08 00 8a 07 04 08 00 10 00"],
    [{ type: "retrievePreset", slot: 35 } as const, "08 00 ca 06 02 08 23"],
    [{ type: "loadPreset", slot: 1 } as const, "08 00 8a 02 02 08 01"],
  ])("%o", (req, expected) => {
    expect(hex(encodeRequest(req))).toBe(expected);
  });

  test("savePresetAs fields", () => {
    const body = new ProtoFields(new ProtoFields(encodeRequest({ type: "savePresetAs", json: "{}", slot: 49, load: false })).bytes(55)!);
    expect([body.string(1), body.bool(2), body.int(3)]).toEqual(["{}", false, 49]);
  });
});

describe("protobuf", () => {
  test("round trips", () => {
    const f = new ProtoFields(new ProtoWriter().int32(1, -2).float(2, 1.5).string(3, "é").finish());
    expect([f.int(1), f.float(2), f.string(3)]).toEqual([-2, 1.5, "é"]);
  });
  test("rejects truncated input", () => {
    expect(() => new ProtoFields(Uint8Array.from([0x0a, 0x05, 0x01]))).toThrow();
  });
});

describe("responses", () => {
  test("connection status", () => {
    expect(decodeMessage(bytes("08 02 da 0c 02 08 00"))).toEqual({ type: "connectionStatus", connected: false });
  });
  test("preset JSON", () => {
    const data = new ProtoWriter().int32(1, 2).message(31, (m) => m.string(1, '{"a":1}').int32(2, 7)).finish();
    expect(decodeMessage(data)).toEqual({ type: "presetJSON", json: '{"a":1}', slot: 7 });
  });
});

describe("framing", () => {
  const payload = Uint8Array.from({ length: 150 }, (_, i) => i % 251);
  const reports = frameReports(payload);
  test("splits into 64-byte reports with first/middle/last tags", () => {
    expect(reports.map((r) => r.length)).toEqual([64, 64, 64]);
    expect(reports.map((r) => r[0])).toEqual([0x33, 0x34, 0x35]);
    expect(reports.map((r) => r[1])).toEqual([61, 61, 28]);
  });
  test("single chunk uses the last tag", () => {
    expect([...frameReports(Uint8Array.from([1, 2])).at(0)!.subarray(0, 4)]).toEqual([0x35, 2, 1, 2]);
  });
  test("reassembles input reports with the amp's leading 0x00", () => {
    const r = new Reassembler();
    let result: Uint8Array | undefined;
    for (const report of reports) result = r.feed(Uint8Array.from([0, ...report]));
    expect(result).toEqual(payload);
  });
  test("ignores an orphan continuation", () => {
    const r = new Reassembler();
    expect(r.feed(reports[1]!)).toBeUndefined();
    r.feed(reports[0]!);
    r.feed(reports[1]!);
    expect(r.feed(reports[2]!)).toEqual(payload);
  });
});
