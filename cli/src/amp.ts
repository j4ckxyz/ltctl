// Talking to a Mustang LT: request/response matching, heartbeat, and the operations
// Fender Tone LT Desktop performs. Behaviour notes (verified on an LT25, firmware 2.1.4):
// - nothing but ConnectionStatus is answered until SYNC_BEGIN has been sent;
// - slots are 1-based, 1–60;
// - SavePresetAs → NewPresetSaved; the amp re-serializes JSON compactly and never stores
//   "bypass": true;
// - after ExitAuditionPreset the amp keeps the auditioned sound as an unsaved edit, so the
//   stored preset is reloaded with LoadPreset;
// - two RetrievePreset requests in flight save ~6%; eight make the amp drop requests.

import { HidTransport, type AttachedAmp } from "./hid";
import {
  type AmpMessage,
  type AmpRequest,
  decodeMessage,
  encodeRequest,
  frameReports,
  MAX_MESSAGE,
  ModalContext,
  Reassembler,
} from "./protocol";
import { Preset, minifyJSON } from "./preset";
import { PresetCache } from "./storage";

export const SLOT_COUNT = 60;
const HEARTBEAT_MS = 1000;
const READ_WINDOW = 2;

export class AmpError extends Error {
  constructor(readonly code: "timeout" | "rejected" | "invalid" | "disconnected", message: string) {
    super(message);
  }
}

export interface AmpInfo {
  usbName: string;
  productId: string;
  firmware: string;
  model: string;
}

const MODEL_NAMES: Record<string, string> = {
  "mustang-lt-25": "Mustang LT25",
  "mustang-lt-40s": "Mustang LT40S",
  "mustang-lt-50": "Mustang LT50",
  "rumble-lt-25": "Rumble LT25",
};

interface Waiter {
  match: (m: AmpMessage) => boolean;
  resolve: (m: AmpMessage) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function describe(req: AmpRequest): string {
  switch (req.type) {
    case "retrievePreset":
    case "loadPreset":
      return `${req.type}(${req.slot})`;
    case "savePresetAs":
      return `savePresetAs(slot ${req.slot}, ${req.json.length} chars)`;
    case "auditionPreset":
      return `auditionPreset(${req.json.length} chars)`;
    case "modalStatus":
      return req.context === ModalContext.syncBegin ? "SYNC_BEGIN" : req.context === ModalContext.syncEnd ? "SYNC_END" : `modal(${req.context})`;
    default:
      return req.type;
  }
}

function describeMessage(m: AmpMessage): string {
  switch (m.type) {
    case "presetJSON":
    case "newPresetSaved":
      return `${m.type}(slot ${m.slot}, ${m.json.length} chars)`;
    case "currentPreset":
      return `currentPreset(slot ${m.slot}, dirty ${m.dirty})`;
    case "auditionPresetStatus":
      return `auditionPresetStatus(${m.json.length} chars)`;
    default:
      return JSON.stringify(m);
  }
}

export class AmpClient {
  /** Unsolicited messages (not answers to our requests). */
  onMessage?: (m: AmpMessage) => void;
  log?: (line: string) => void;
  info?: AmpInfo;

  private transport?: HidTransport;
  private reassembler = new Reassembler();
  private waiters = new Set<Waiter>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastSend = 0;
  private sendChain: Promise<void> = Promise.resolve();
  private syncing = false;

  /** Opens USB and performs the handshake (SYNC_BEGIN, firmware, product id). */
  async connect(): Promise<AmpInfo> {
    const transport = await HidTransport.open();
    this.transport = transport;
    transport.onReport = (report) => this.handle(report);
    transport.onError = (error) => this.failAll(new AmpError("disconnected", `The amp disconnected (${error}).`));
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastSend >= HEARTBEAT_MS * 0.9) this.send({ type: "heartbeat" }).catch(() => {});
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
    try {
      await this.request({ type: "modalStatus", context: ModalContext.syncBegin, state: 0 }, (m) => m.type === "modalStatus" && m.context === ModalContext.syncBegin);
      this.syncing = true;
      const fw = await this.request({ type: "firmwareVersion" }, (m) => m.type === "firmwareVersion");
      const pid = await this.request({ type: "productIdentification" }, (m) => m.type === "productIdentification");
      const productId = pid.type === "productIdentification" ? pid.id : "";
      this.info = {
        usbName: transport.amp.name,
        productId,
        firmware: fw.type === "firmwareVersion" ? fw.version : "",
        model: MODEL_NAMES[productId] ?? transport.amp.name,
      };
      return this.info;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  get attached(): AttachedAmp | undefined {
    return this.transport?.amp;
  }

  /** Ends the sync phase. Fender Tone only changes the amp after this. */
  async endSync(): Promise<void> {
    if (!this.syncing) return;
    await this.request({ type: "modalStatus", context: ModalContext.syncEnd, state: 0 }, (m) => m.type === "modalStatus" && m.context === ModalContext.syncEnd);
    this.syncing = false;
  }

  /** Ends sync if needed and closes. See HidTransport.close for `release`. */
  async close(release = true): Promise<void> {
    if (this.syncing && this.transport) await this.endSync().catch(() => {});
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.failAll(new AmpError("disconnected", "Connection closed."));
    await this.transport?.close(release);
    this.transport = undefined;
  }

  // ------------------------------------------------------------ messaging

  /** Sends one message; chunks of different messages never interleave. */
  send(req: AmpRequest): Promise<void> {
    const payload = encodeRequest(req);
    if (payload.length > MAX_MESSAGE) {
      return Promise.reject(new AmpError("invalid", `Message is ${payload.length} bytes; the amp accepts at most ${MAX_MESSAGE}.`));
    }
    const transport = this.transport;
    if (!transport) return Promise.reject(new AmpError("disconnected", "Not connected."));
    if (req.type !== "heartbeat") this.log?.(`→ ${describe(req)}`);
    const run = async () => {
      for (const report of frameReports(payload)) await transport.write(report);
      this.lastSend = Date.now();
    };
    const next = this.sendChain.then(run, run);
    this.sendChain = next.catch(() => {});
    return next;
  }

  request(req: AmpRequest, match: (m: AmpMessage) => boolean, timeoutMs = 3000): Promise<AmpMessage> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new AmpError("timeout", `The amp did not answer (${describe(req)}).`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
      this.send(req).catch((error) => {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        reject(error);
      });
    });
  }

  private handle(report: Uint8Array): void {
    const payload = this.reassembler.feed(report);
    if (!payload) return;
    let message: AmpMessage;
    try {
      message = decodeMessage(payload);
    } catch {
      this.log?.(`← undecodable ${Buffer.from(payload).toString("hex")}`);
      return;
    }
    if (message.type !== "heartbeat") this.log?.(`← ${describeMessage(message)}`);
    for (const waiter of this.waiters) {
      if (waiter.match(message)) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(message);
        return;
      }
    }
    this.onMessage?.(message);
  }

  private failAll(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  // ------------------------------------------------------------ presets

  private checkSlot(slot: number): void {
    if (!Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT) throw new AmpError("invalid", `Slot ${slot} does not exist (slots are 1–${SLOT_COUNT}).`);
  }

  /** One RetrievePreset round trip; reads are harmless, so a lost request is retried once. */
  private async fetchPreset(slot: number): Promise<Preset> {
    this.checkSlot(slot);
    for (let attempt = 0; ; attempt++) {
      try {
        const m = await this.request({ type: "retrievePreset", slot }, (x) => x.type === "presetJSON" && x.slot === slot, 1500);
        if (m.type !== "presetJSON") throw new AmpError("timeout", `preset ${slot}`);
        return Preset.parse(m.json, slot);
      } catch (error) {
        if (attempt > 0 || !(error instanceof AmpError) || error.code !== "timeout") throw error;
      }
    }
  }

  async readPreset(slot: number): Promise<Preset> {
    const preset = await this.fetchPreset(slot);
    this.cache([preset]);
    return preset;
  }

  /** Reads slots with two requests in flight; `onEach` fires in slot order as they arrive. */
  async readPresets(slots: number[], onEach?: (p: Preset) => void): Promise<Preset[]> {
    slots.forEach((s) => this.checkSlot(s));
    const results = new Array<Preset | undefined>(slots.length);
    let next = 0;
    let emitted = 0;
    const flush = () => {
      while (emitted < slots.length && results[emitted]) {
        const ready = results[emitted]!;
        emitted += 1; // not inside onEach?.(…): with no callback the arguments aren't evaluated
        onEach?.(ready);
      }
    };
    const worker = async () => {
      while (next < slots.length) {
        const index = next++;
        results[index] = await this.fetchPreset(slots[index]!);
        flush();
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_WINDOW, slots.length) }, worker));
    const presets = results as Preset[];
    this.cache(presets);
    return presets;
  }

  async readAll(onEach?: (p: Preset) => void): Promise<Preset[]> {
    return this.readPresets(Array.from({ length: SLOT_COUNT }, (_, i) => i + 1), onEach);
  }

  /** The active slot, whether it has unsaved edits, and the live preset. */
  async current(): Promise<{ slot: number; dirty: boolean; preset: Preset }> {
    const m = await this.request({ type: "currentPreset" }, (x) => x.type === "currentPreset");
    if (m.type !== "currentPreset") throw new AmpError("timeout", "current preset");
    return { slot: m.slot, dirty: m.dirty, preset: Preset.parse(m.json, m.slot) };
  }

  async load(slot: number): Promise<void> {
    this.checkSlot(slot);
    await this.endSync();
    await this.request({ type: "loadPreset", slot }, (m) => (m.type === "currentLoadedPresetIndex" || m.type === "currentPreset") && m.slot === slot);
  }

  /** Stores a preset (SavePresetAs, as Fender Tone's Paste/Duplicate) and reads it back. */
  async write(preset: Preset, slot: number): Promise<Preset> {
    this.checkSlot(slot);
    await this.endSync();
    const json = wireJSON(preset.json);
    const reply = await this.request(
      { type: "savePresetAs", json, slot, load: false },
      (m) => ((m.type === "presetSaved" || m.type === "newPresetSaved") && m.slot === slot) || m.type === "unsupported",
      5000,
    );
    if (reply.type === "unsupported") throw new AmpError("rejected", `The amp rejected the preset (error ${reply.code}).`);
    return this.readPreset(slot);
  }

  /** Plays a preset without storing it (Fender Tone's Auto-Audition). */
  async audition(preset: Preset): Promise<void> {
    await this.endSync();
    const reply = await this.request({ type: "auditionPreset", json: wireJSON(preset.json) }, (m) => m.type === "auditionPresetStatus" || m.type === "unsupported");
    if (reply.type === "unsupported") throw new AmpError("rejected", `The amp rejected the preset (error ${reply.code}).`);
  }

  async exitAudition(): Promise<void> {
    await this.endSync();
    await this.request({ type: "exitAudition" }, (m) => m.type === "exitAuditionStatus" || m.type === "unsupported");
    const { slot } = await this.current();
    await this.load(slot);
  }

  private cache(presets: Preset[]): void {
    if (this.info?.productId) PresetCache.store(presets, this.info.productId);
  }
}

/** JSON exactly as given, minified only if needed to fit the amp's message limit. */
export function wireJSON(json: string): string {
  const trimmed = json.trim();
  const size = encodeRequest({ type: "savePresetAs", json: trimmed, slot: 1, load: false }).length;
  return size <= MAX_MESSAGE ? trimmed : minifyJSON(trimmed);
}
