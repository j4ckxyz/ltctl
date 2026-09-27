// Edits presets through human-level assignments such as `amp=ac30`, `amp.gain=6.5`,
// `delay.time=400ms`, `amp.cabinet="2x12 blue"`, `delay=none` or `name="Spread Wings"`.
// Numbers are what the amp shows; tapers and stored ranges are handled here.

import { type Catalog, formatNumber, type ParamSpec, type ParamValue, PASSTHRU, type Position, POSITIONS } from "./catalog";
import { ampName, Preset } from "./preset";

export class EditError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
  }
}

/** Lower-case letters and digits only, for forgiving matching. */
export const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const EMPTY_WORDS = new Set(["none", "off", "empty", "passthru", "bypass", "", "null"]);
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

export class PresetEditor {
  private root: any;

  constructor(readonly catalog: Catalog, preset?: Preset) {
    if (preset) {
      this.root = JSON.parse(preset.json);
    } else {
      if (!catalog.emptyPresetJSON) throw new EditError("the catalogue has no EMPTY preset template");
      this.root = JSON.parse(catalog.emptyPresetJSON);
      this.root.info = { ...this.root.info, is_factory_default: false, preset_id: crypto.randomUUID(), timestamp: Math.floor(Date.now() / 1000) };
    }
  }

  preset(slot?: number): Preset {
    return Preset.parse(JSON.stringify(this.root), slot);
  }

  /** Applies "key=value". */
  apply(assignment: string): void {
    const eq = assignment.indexOf("=");
    if (eq < 0) throw new EditError(`"${assignment}" is not an assignment`, "use key=value, e.g. amp.gain=6.5");
    this.set(assignment.slice(0, eq), assignment.slice(eq + 1));
  }

  set(rawKey: string, rawValue: string): void {
    const key = rawKey.trim();
    const value = rawValue.trim().replace(/^(["'])(.*)\1$/, "$2");
    if (normalize(key) === "name") return this.setName(value);
    const [head, param] = key.split(/\.(.*)/s);
    const position = POSITIONS.find((p) => p === normalize(head ?? ""));
    if (!position) throw new EditError(`unknown key "${key}"`, "keys: name, stomp, mod, amp, delay, reverb, or <position>.<parameter>");
    if (!param || (["unit", "model"].includes(normalize(param)) && !this.hasParam(position, param))) {
      this.setUnit(position, value);
    } else {
      this.setParam(position, param, value);
    }
  }

  setName(text: string): void {
    try {
      this.root.info = { ...this.root.info, displayName: ampName(text) };
    } catch (error) {
      throw new EditError((error as Error).message);
    }
  }

  /** Puts a unit in a position, resetting its parameters to that unit's defaults. */
  setUnit(position: Position, query: string): void {
    const fenderId = this.resolveUnit(position, query);
    const params: Record<string, ParamValue> = fenderId === PASSTHRU ? {} : { ...(this.catalog.unit(fenderId)?.defaults ?? {}) };
    if (position !== "amp") {
      params.bypass = false;
      // The amp stores delay and reverb units as "Pre" whatever it is sent; empty positions
      // and pre-amp effects are "Post" (as in the factory presets).
      params.bypassType = fenderId !== PASSTHRU && (position === "delay" || position === "reverb") ? "Pre" : "Post";
    }
    const node = this.node(position);
    node.FenderId = fenderId;
    node.dspUnitParameters = params;
  }

  resolveUnit(position: Position, query: string): string {
    if (EMPTY_WORDS.has(normalize(query))) {
      if (position === "amp") throw new EditError("the amp position can't be empty", "choose an amp model");
      return PASSTHRU;
    }
    const q = normalize(query);
    const candidates = (this.catalog.options.get(position) ?? []).filter((o) => o.fenderId !== PASSTHRU);
    const names = (id: string) =>
      [id, id.replace(/^DUBS_/, ""), this.catalog.menuName(id) ?? "", this.catalog.unit(id)?.displayName ?? ""].map(normalize);
    const exact = candidates.find((o) => names(o.fenderId).includes(q));
    if (exact) return exact.fenderId;
    const partial = candidates.filter((o) => names(o.fenderId).some((n) => n.includes(q)));
    if (partial.length === 1) return partial[0]!.fenderId;
    if (partial.length > 1) {
      throw new EditError(`"${query}" matches several ${position} units: ${partial.map((o) => o.menuName).join(", ")}`, "be more specific");
    }
    const choices = [...(position === "amp" ? [] : ["none"]), ...candidates.map((o) => o.menuName)];
    throw new EditError(`no ${position} unit called "${query}"`, `choose one of: ${choices.join(", ")}`);
  }

  /** Sets a parameter from a display value, list option or raw:<value>. */
  setParam(position: Position, query: string, text: string): void {
    const node = this.node(position);
    if (node.FenderId === PASSTHRU) throw new EditError(`the ${position} position is empty`, `set ${position}=<unit> first`);
    const unit = this.catalog.unit(node.FenderId);
    if (!unit) throw new EditError(`unknown unit ${node.FenderId}`);
    const params: Record<string, ParamValue> = (node.dspUnitParameters ??= {});
    let spec = unit.params.find((p) => matches(p, query));
    if (!spec) {
      // A unique partial name also works ("cab" → cabsimType); ambiguous ones are listed.
      const q = normalize(query);
      const partial = q ? unit.params.filter((p) => normalize(p.id).includes(q) || normalize(p.displayName).includes(q)) : [];
      if (partial.length === 1) spec = partial[0];
      else if (partial.length > 1) {
        throw new EditError(`"${query}" matches several ${this.catalog.menuName(node.FenderId) ?? unit.displayName} parameters`, `use one of: ${partial.map(shortName).join(", ")}`);
      }
    }
    let id: string;
    let value: ParamValue;
    const unitName = this.catalog.menuName(node.FenderId) ?? unit.displayName;
    if (spec) {
      id = spec.id;
      value = parseValue(text, spec, unitName);
    } else {
      const stored = [...Object.keys(params), ...Object.keys(unit.defaults)].find((k) => normalize(k) === normalize(query));
      if (!stored) {
        throw new EditError(`${unitName} has no parameter "${query}"`, `parameters: ${unit.params.map(shortName).join(", ")}`);
      }
      id = stored; // stored field without an editor definition (e.g. tapTimeBPM): raw value
      value = parseRaw(text.replace(/^raw:/i, ""));
    }
    params[id] = value;
    if (unit.tapParameter === id && typeof value === "number" && value > 0 && "tapTimeBPM" in params) {
      params.tapTimeBPM = round6(60 / value); // keep the tap-tempo readout in step
    }
  }

  private node(position: Position): any {
    const node = (this.root.audioGraph?.nodes ?? []).find((n: any) => n.nodeId === position);
    if (!node) throw new EditError(`preset has no ${position} node`);
    return node;
  }

  private hasParam(position: Position, query: string): boolean {
    const unit = this.catalog.unit(this.node(position).FenderId);
    return !!unit?.params.some((p) => matches(p, query));
  }
}

function matches(spec: ParamSpec, query: string): boolean {
  const q = normalize(query);
  return normalize(spec.id) === q || normalize(spec.displayName) === q;
}

/** "treb (treble)": the id, plus the display name when it reads differently. */
export function shortName(spec: ParamSpec): string {
  const display = spec.displayName.toLowerCase();
  return !display || normalize(display) === normalize(spec.id) ? spec.id : `${spec.id} (${display})`;
}

export function rangeHint(spec: ParamSpec): string {
  if (spec.hasDisplayRange) {
    return `${spec.id} is ${formatNumber(spec.remap!.min!)}…${formatNumber(spec.remap!.max!)}${spec.displayUnits ? " " + spec.displayUnits : ""} (or raw:${formatNumber(spec.min ?? 0)}…${formatNumber(spec.max ?? 1)})`;
  }
  return `${spec.id} is ${formatNumber(spec.min ?? 0)}…${formatNumber(spec.max ?? 1)}${spec.rawUnits ? " " + spec.rawUnits : ""}`;
}

function parseRaw(text: string): ParamValue {
  const t = text.trim();
  if (t !== "" && !Number.isNaN(Number(t))) return Number(t);
  if (t.toLowerCase() === "true") return true;
  if (t.toLowerCase() === "false") return false;
  return t.replace(/^"|"$/g, "");
}

export function parseValue(text: string, spec: ParamSpec, unitName: string): ParamValue {
  const t = text.trim();
  if (/^raw:/i.test(t)) {
    const raw = parseRaw(t.slice(4));
    if (spec.kind === "continuous" && typeof raw === "number" && spec.min !== undefined && spec.max !== undefined) {
      const [lo, hi] = [Math.min(spec.min, spec.max), Math.max(spec.min, spec.max)];
      if (raw < lo - 1e-9 || raw > hi + 1e-9) throw new EditError(`raw ${spec.id} ${raw} is outside ${formatNumber(lo)}…${formatNumber(hi)}`);
    }
    return raw;
  }
  const labels = spec.remap?.listItems ?? [];
  if (spec.kind === "listBool") {
    const q = normalize(t);
    if (["on", "true", "yes", "1", normalize(labels[1] ?? "on")].includes(q)) return true;
    if (["off", "false", "no", "0", normalize(labels[0] ?? "off")].includes(q)) return false;
    throw new EditError(`${spec.id} is on or off, not "${t}"`);
  }
  if (spec.kind === "list") {
    const q = normalize(t);
    const exact = spec.listItems.findIndex((item, i) => normalize(item) === q || normalize(labels[i] ?? "\u0000") === q);
    if (exact >= 0) return spec.listItems[exact]!;
    const partial = spec.listItems.map((_, i) => i).filter((i) => normalize(spec.listItems[i]!).includes(q) || normalize(labels[i] ?? "\u0000").includes(q));
    if (partial.length === 1) return spec.listItems[partial[0]!]!;
    const options = spec.listItems.map((item, i) => (labels[i] && normalize(labels[i]!) !== normalize(item) ? `${item} (${labels[i]})` : item));
    throw new EditError(`${unitName} ${spec.id} can't be "${t}"`, `options: ${options.join(", ")}`);
  }
  // continuous: strip units; "0.4s" means 400 ms where the display is in ms
  let s = t.toLowerCase().replace(/\s+/g, "");
  let scale = 1;
  const displayUnit = spec.displayUnits?.toLowerCase();
  if (displayUnit === "ms" && s.endsWith("ms")) s = s.slice(0, -2);
  else if (displayUnit === "ms" && s.endsWith("s")) {
    s = s.slice(0, -1);
    scale = 1000;
  } else s = s.replace(/(db|%|hz|ms)$/, "");
  const number = Number(s);
  if (s === "" || Number.isNaN(number)) throw new EditError(`${spec.id} needs a number, not "${t}"`, rangeHint(spec));
  const display = number * scale;
  const [lo, hi] = spec.hasDisplayRange
    ? [Math.min(spec.remap!.min!, spec.remap!.max!), Math.max(spec.remap!.min!, spec.remap!.max!)]
    : [Math.min(spec.min ?? -Infinity, spec.max ?? Infinity), Math.max(spec.min ?? -Infinity, spec.max ?? Infinity)];
  if (display < lo - 1e-9 || display > hi + 1e-9) throw new EditError(`${unitName} ${spec.id} ${formatNumber(display)} is out of range`, rangeHint(spec));
  const raw = spec.rawValue(display);
  return raw === undefined ? display : round6(raw);
}
