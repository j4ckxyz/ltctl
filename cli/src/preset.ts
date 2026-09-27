// A preset: the amp's JSON kept exactly as stored, plus a parsed view.

import type { Catalog, ParamValue, Position } from "./catalog";
import { PASSTHRU, POSITIONS } from "./catalog";
import { encodeRequest, MAX_MESSAGE } from "./protocol";

export interface PresetNode {
  nodeId: string;
  fenderId: string;
  params: Record<string, ParamValue>;
}

export class Preset {
  private constructor(
    /** The JSON exactly as read or written. */
    readonly json: string,
    /** 1-based amp slot, undefined for files and the factory library. */
    readonly slot: number | undefined,
    /** 16 characters: two 8-character fields, e.g. "FENDER  CLEAN   ". */
    readonly rawName: string,
    readonly productId: string,
    readonly nodes: PresetNode[],
  ) {}

  static parse(json: string, slot: number | undefined): Preset {
    let root: any;
    try {
      root = JSON.parse(json);
    } catch {
      throw new PresetError("not valid JSON");
    }
    if (root?.nodeType !== "preset") throw new PresetError('missing "nodeType": "preset"');
    const nodes = root.audioGraph?.nodes;
    if (!Array.isArray(nodes)) throw new PresetError("missing audioGraph.nodes");
    return new Preset(
      json,
      slot,
      String(root.info?.displayName ?? ""),
      String(root.info?.product_id ?? ""),
      nodes.map((n: any) => ({ nodeId: String(n.nodeId ?? ""), fenderId: String(n.FenderId ?? ""), params: n.dspUnitParameters ?? {} })),
    );
  }

  withSlot(slot: number | undefined): Preset {
    return new Preset(this.json, slot, this.rawName, this.productId, this.nodes);
  }

  get isEmptySlot(): boolean {
    return this.rawName.trim() === "EMPTY";
  }

  /** "JAZZ       AMP  " → "Jazz Amp" (as Fender Tone shows names). */
  get displayName(): string {
    return displayName(this.rawName);
  }

  node(position: Position): PresetNode | undefined {
    return this.nodes.find((n) => n.nodeId === position);
  }

  /** "35 Warm Lead", for file names. */
  get fileBaseName(): string {
    const name = (this.displayName || "Preset").replace(/[/:\\]/g, "-");
    return this.slot === undefined ? name : `${String(this.slot).padStart(2, "0")} ${name}`;
  }

  /** Problems that would stop the amp accepting this preset. */
  validate(catalog: Catalog | undefined): string[] {
    const problems: string[] = [];
    if (this.rawName.length > 16) problems.push(`name "${this.rawName}" is longer than 16 characters`);
    if (this.productId && this.productId !== "mustang-lt") problems.push(`preset is for "${this.productId}", not a Mustang LT`);
    for (const position of POSITIONS) if (!this.node(position)) problems.push(`missing the "${position}" node`);
    for (const node of this.nodes) {
      if (node.params.bypass === true && node.fenderId !== PASSTHRU) {
        problems.push(`${node.nodeId} has "bypass": true, which the amp doesn't store; use ${node.nodeId}=none to leave it out`);
      }
      const allowed = catalog?.options.get(node.nodeId as Position);
      if (allowed && !allowed.some((o) => o.fenderId === node.fenderId)) {
        problems.push(`${node.fenderId} is not available in the ${node.nodeId} position on a Mustang LT`);
      }
    }
    const size = encodeRequest({ type: "savePresetAs", json: minifyJSON(this.json), slot: 1, load: false }).length;
    if (size > MAX_MESSAGE) problems.push(`preset is too large to send (${size} bytes, limit ${MAX_MESSAGE})`);
    return problems;
  }

  /**
   * Same content as the amp would store it: formatting is ignored (the amp re-serializes
   * JSON) and so is `bypassType`, which the amp sets itself per unit.
   */
  sameContent(other: Preset): boolean {
    return canonical(JSON.parse(this.json)) === canonical(JSON.parse(other.json));
  }
}

export class PresetError extends Error {}

export function displayName(rawName: string): string {
  const fields = [rawName.slice(0, 8), rawName.slice(8, 16)].map((f) => f.trim()).filter(Boolean);
  return fields
    .join(" ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((k) => k !== "bypassType").sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Removes insignificant whitespace without re-encoding values. */
export function minifyJSON(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const c of json) {
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (!/\s/.test(c)) out += c;
  }
  return out;
}

// ---------------------------------------------------------------- names

const NAME_CHARS = /^[A-Za-z0-9 ]*$/; // ToneDeviceLT::allowedPresetNameChars

/** "Spread Wings" → "SPREAD  WINGS   " (two display lines of 8). */
export function ampName(text: string): string {
  if (text.length === 16 && NAME_CHARS.test(text)) return text.toUpperCase();
  const cleaned = text.toUpperCase().trim().split(/\s+/).join(" ");
  if (!NAME_CHARS.test(cleaned)) {
    const bad = [...cleaned].find((c) => !/[A-Z0-9 ]/.test(c));
    throw new PresetError(`the amp can't show "${bad}" in a preset name (use letters, digits and spaces)`);
  }
  if (!cleaned) throw new PresetError("preset name is empty");
  const pad = (s: string) => s.padEnd(8, " ");
  const words = cleaned.split(" ");
  // One word on the first line; several words across both lines, as Fender's presets do.
  if (words.length === 1 && cleaned.length <= 8) return pad(cleaned) + pad("");
  for (let split = words.length - 1; split >= 1; split--) {
    const first = words.slice(0, split).join(" ");
    const second = words.slice(split).join(" ");
    if (first.length <= 8 && second.length <= 8) return pad(first) + pad(second);
  }
  if (!cleaned.includes(" ") && cleaned.length <= 16) return pad(cleaned.slice(0, 8)) + pad(cleaned.slice(8));
  const suggestion = words.slice(0, 2).map((w) => w.slice(0, 8)).join(" ");
  throw new PresetError(`"${text}" doesn't fit the amp's display (two lines of 8 characters); try "${suggestion}"`);
}
