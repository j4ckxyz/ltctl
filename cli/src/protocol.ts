// Mustang LT USB protocol: FenderMessageLT protobuf messages framed into 64-byte HID
// reports. Field numbers come from the descriptors compiled into Fender Tone LT Desktop
// 1.5.0; see docs/PROTOCOL.md.

// ---------------------------------------------------------------- protobuf (proto2 subset)

export class ProtoWriter {
  private bytes: number[] = [];

  private varint(value: bigint): void {
    let v = BigInt.asUintN(64, value);
    while (v >= 0x80n) {
      this.bytes.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.bytes.push(Number(v));
  }

  private key(field: number, wireType: number): void {
    this.varint(BigInt((field << 3) | wireType));
  }

  int32(field: number, value: number): this {
    this.key(field, 0);
    this.varint(BigInt(value)); // negatives sign-extend to 64 bits
    return this;
  }

  bool(field: number, value: boolean): this {
    this.key(field, 0);
    this.varint(value ? 1n : 0n);
    return this;
  }

  float(field: number, value: number): this {
    this.key(field, 5);
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, value, true);
    this.bytes.push(...b);
    return this;
  }

  bytesField(field: number, value: Uint8Array): this {
    this.key(field, 2);
    this.varint(BigInt(value.length));
    for (const b of value) this.bytes.push(b);
    return this;
  }

  string(field: number, value: string): this {
    return this.bytesField(field, new TextEncoder().encode(value));
  }

  message(field: number, build: (w: ProtoWriter) => void): this {
    const inner = new ProtoWriter();
    build(inner);
    return this.bytesField(field, inner.finish());
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

export type ProtoValue =
  | { kind: "varint"; value: bigint }
  | { kind: "fixed64"; value: bigint }
  | { kind: "bytes"; value: Uint8Array }
  | { kind: "fixed32"; value: number };

export class ProtoFields {
  readonly entries: { field: number; value: ProtoValue }[] = [];

  constructor(data: Uint8Array) {
    let i = 0;
    const readVarint = (): bigint => {
      let result = 0n;
      let shift = 0n;
      for (;;) {
        if (i >= data.length || shift >= 64n) throw new Error("truncated protobuf");
        const b = data[i++]!;
        result |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) return result;
        shift += 7n;
      }
    };
    const take = (n: number): Uint8Array => {
      if (n < 0 || i + n > data.length) throw new Error("truncated protobuf");
      const out = data.subarray(i, i + n);
      i += n;
      return out;
    };
    while (i < data.length) {
      const key = readVarint();
      const field = Number(key >> 3n);
      switch (Number(key & 7n)) {
        case 0:
          this.entries.push({ field, value: { kind: "varint", value: readVarint() } });
          break;
        case 1:
          this.entries.push({ field, value: { kind: "fixed64", value: new DataView(take(8).slice().buffer).getBigUint64(0, true) } });
          break;
        case 2:
          this.entries.push({ field, value: { kind: "bytes", value: take(Number(readVarint())) } });
          break;
        case 5:
          this.entries.push({ field, value: { kind: "fixed32", value: new DataView(take(4).slice().buffer).getUint32(0, true) } });
          break;
        default:
          throw new Error(`unsupported wire type ${Number(key & 7n)}`);
      }
    }
  }

  first(field: number): ProtoValue | undefined {
    return this.entries.find((e) => e.field === field)?.value;
  }

  int(field: number): number | undefined {
    const v = this.first(field);
    return v?.kind === "varint" ? Number(BigInt.asIntN(32, v.value)) : undefined;
  }

  bool(field: number): boolean | undefined {
    const v = this.first(field);
    return v?.kind === "varint" ? v.value !== 0n : undefined;
  }

  float(field: number): number | undefined {
    const v = this.first(field);
    if (v?.kind !== "fixed32") return undefined;
    const dv = new DataView(new ArrayBuffer(4));
    dv.setUint32(0, v.value, true);
    return dv.getFloat32(0, true);
  }

  bytes(field: number): Uint8Array | undefined {
    const v = this.first(field);
    return v?.kind === "bytes" ? v.value : undefined;
  }

  string(field: number): string | undefined {
    const b = this.bytes(field);
    return b ? new TextDecoder().decode(b) : undefined;
  }

  /** Repeated varints, packed or not. */
  varints(field: number): number[] {
    const out: number[] = [];
    for (const e of this.entries.filter((x) => x.field === field)) {
      if (e.value.kind === "varint") out.push(Number(e.value.value));
      else if (e.value.kind === "bytes") {
        let result = 0;
        let shift = 0;
        for (const b of e.value.value) {
          result |= (b & 0x7f) << shift;
          if ((b & 0x80) === 0) {
            out.push(result);
            result = 0;
            shift = 0;
          } else shift += 7;
        }
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- messages

export const ModalContext = { syncBegin: 0, syncEnd: 1 } as const;

/** Host → amp messages. Only what Fender Tone LT Desktop itself sends. */
export type AmpRequest =
  | { type: "heartbeat" }
  | { type: "connectionStatus" }
  | { type: "modalStatus"; context: number; state: number }
  | { type: "firmwareVersion" }
  | { type: "productIdentification" }
  | { type: "retrievePreset"; slot: number }
  | { type: "currentPreset" }
  | { type: "loadPreset"; slot: number }
  | { type: "auditionPreset"; json: string }
  | { type: "exitAudition" }
  | { type: "savePresetAs"; json: string; slot: number; load: boolean };

const requestField: Record<AmpRequest["type"], number> = {
  heartbeat: 201,
  connectionStatus: 202,
  modalStatus: 113,
  firmwareVersion: 102,
  productIdentification: 101,
  retrievePreset: 105,
  currentPreset: 104,
  loadPreset: 33,
  auditionPreset: 58,
  exitAudition: 60,
  savePresetAs: 55,
};

export function encodeRequest(req: AmpRequest): Uint8Array {
  return new ProtoWriter()
    .int32(1, 0) // responseType = UNSOLICITED
    .message(requestField[req.type], (m) => {
      switch (req.type) {
        case "modalStatus":
          m.int32(1, req.context).int32(2, req.state);
          break;
        case "retrievePreset":
        case "loadPreset":
          m.int32(1, req.slot);
          break;
        case "auditionPreset":
          m.string(1, req.json);
          break;
        case "savePresetAs":
          m.string(1, req.json).bool(2, req.load).int32(3, req.slot);
          break;
        default:
          m.bool(1, true);
      }
    })
    .finish();
}

/** Amp → host messages. */
export type AmpMessage =
  | { type: "connectionStatus"; connected: boolean }
  | { type: "heartbeat" }
  | { type: "modalStatus"; context: number; state: number }
  | { type: "firmwareVersion"; version: string }
  | { type: "productIdentification"; id: string }
  | { type: "presetJSON"; json: string; slot: number }
  | { type: "currentPreset"; json: string; slot: number; dirty: boolean }
  | { type: "currentLoadedPresetIndex"; slot: number }
  | { type: "presetEdited"; edited: boolean }
  | { type: "presetSaved"; name: string; slot: number }
  | { type: "newPresetSaved"; json: string; slot: number }
  | { type: "auditionPresetStatus"; json: string }
  | { type: "exitAuditionStatus"; ok: boolean }
  | { type: "unsupported"; code: number }
  | { type: "other"; field: number };

export function decodeMessage(data: Uint8Array): AmpMessage {
  const top = new ProtoFields(data);
  const entry = top.entries.find((e) => e.field !== 1);
  if (!entry || entry.value.kind !== "bytes") return { type: "other", field: entry?.field ?? 0 };
  const m = new ProtoFields(entry.value.value);
  switch (entry.field) {
    case 203: return { type: "connectionStatus", connected: m.bool(1) ?? false };
    case 201: return { type: "heartbeat" };
    case 113: return { type: "modalStatus", context: m.int(1) ?? -1, state: m.int(2) ?? -1 };
    case 103: return { type: "firmwareVersion", version: m.string(1) ?? "" };
    case 100: return { type: "productIdentification", id: m.string(1) ?? "" };
    case 31: return { type: "presetJSON", json: m.string(1) ?? "", slot: m.int(2) ?? -1 };
    case 32: return { type: "currentPreset", json: m.string(1) ?? "", slot: m.int(2) ?? -1, dirty: m.bool(3) ?? false };
    case 37: return { type: "currentLoadedPresetIndex", slot: m.int(1) ?? -1 };
    case 38: return { type: "presetEdited", edited: m.bool(1) ?? false };
    case 50: return { type: "presetSaved", name: m.string(1) ?? "", slot: m.int(2) ?? -1 };
    case 56: return { type: "newPresetSaved", json: m.string(1) ?? "", slot: m.int(2) ?? -1 };
    case 59: return { type: "auditionPresetStatus", json: m.string(1) ?? "" };
    case 61: return { type: "exitAuditionStatus", ok: m.bool(1) ?? false };
    case 200: return { type: "unsupported", code: m.int(1) ?? -1 };
    default: return { type: "other", field: entry.field };
  }
}

// ---------------------------------------------------------------- HID framing

export const REPORT_SIZE = 64;
export const MAX_CHUNK = 61;
export const MAX_MESSAGE = 4000; // FenderMessageLTEncoder MTU

const TAG_FIRST = 0x33;
const TAG_MIDDLE = 0x34;
const TAG_LAST = 0x35;

/** Splits a payload into 64-byte reports: [tag, length, payload…] zero padded. */
export function frameReports(payload: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < payload.length; i += MAX_CHUNK) chunks.push(payload.subarray(i, i + MAX_CHUNK));
  if (chunks.length === 0) chunks.push(new Uint8Array());
  return chunks.map((chunk, index) => {
    const report = new Uint8Array(REPORT_SIZE);
    report[0] = index === chunks.length - 1 ? TAG_LAST : index === 0 ? TAG_FIRST : TAG_MIDDLE;
    report[1] = chunk.length;
    report.set(chunk, 2);
    return report;
  });
}

/** Rebuilds payloads from input reports (which the amp prefixes with an extra 0x00). */
export class Reassembler {
  private buffer: number[] = [];
  private inMessage = false;

  feed(report: Uint8Array): Uint8Array | undefined {
    let bytes = report;
    if (bytes[0] === 0 && bytes.length > 1 && bytes[1]! >= TAG_FIRST && bytes[1]! <= TAG_LAST) bytes = bytes.subarray(1);
    if (bytes.length < 2) return undefined;
    const tag = bytes[0]!;
    if (tag < TAG_FIRST || tag > TAG_LAST) return undefined;
    const chunk = bytes.subarray(2, 2 + Math.min(bytes[1]!, bytes.length - 2));
    if (tag === TAG_FIRST) {
      this.buffer = [...chunk];
      this.inMessage = true;
      return undefined;
    }
    if (tag === TAG_MIDDLE) {
      if (this.inMessage) this.buffer.push(...chunk);
      return undefined;
    }
    const out = this.inMessage ? Uint8Array.from([...this.buffer, ...chunk]) : Uint8Array.from(chunk);
    this.buffer = [];
    this.inMessage = false;
    return out;
  }
}
