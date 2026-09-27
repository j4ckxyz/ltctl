// CLI plumbing: output modes, errors/exit codes, preset references, amp sessions.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AmpClient, AmpError, SLOT_COUNT } from "./amp";
import { Catalog } from "./catalog";
import { EditError, normalize } from "./editor";
import { HidError } from "./hid";
import { Preset, PresetError } from "./preset";
import { PresetCache, readPresetFile } from "./storage";

// ---------------------------------------------------------------- output

export const out = {
  json: process.argv.includes("--json"),
  quiet: false,
  verbose: false,
  color: !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb",
  stdoutTTY: !!process.stdout.isTTY,
  stderrTTY: !!process.stderr.isTTY,

  /** Human output on stdout (silent in --json mode). */
  line(text = ""): void {
    if (!this.json) process.stdout.write(text + "\n");
  },
  /** Diagnostics on stderr (silent with --quiet / --json). */
  note(text: string): void {
    if (!this.quiet && !this.json) process.stderr.write(text + "\n");
  },
  progress(text: string): void {
    if (this.stderrTTY && !this.quiet && !this.json) process.stderr.write(`\r\x1b[2K${text}`);
  },
  endProgress(): void {
    if (this.stderrTTY && !this.quiet && !this.json) process.stderr.write("\r\x1b[2K");
  },
  /** The one JSON document of --json mode. */
  emit(value: unknown): void {
    process.stdout.write(JSON.stringify(value, null, this.stdoutTTY ? 2 : undefined) + "\n");
  },
  bold: (s: string) => (out.color ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (out.color ? `\x1b[2m${s}\x1b[0m` : s),
  accent: (s: string) => (out.color ? `\x1b[31m${s}\x1b[0m` : s),
};

// ---------------------------------------------------------------- errors

/** Exit codes are part of the interface (see `ltctl guide`). */
export const Exit = {
  ok: 0,
  failure: 1,
  usage: 2,
  ampNotFound: 3,
  ampBusy: 4,
  invalid: 5,
  refused: 6,
  ampError: 7,
  notFound: 8,
} as const;

export class CliError extends Error {
  constructor(readonly code: string, message: string, readonly hint: string | undefined, readonly exit: number) {
    super(message);
  }

  static from(error: unknown): CliError {
    if (error instanceof CliError) return error;
    if (error instanceof EditError) return new CliError("invalid_input", error.message, error.hint, Exit.invalid);
    if (error instanceof PresetError) return new CliError("invalid_preset", `Invalid preset: ${error.message}`, undefined, Exit.invalid);
    if (error instanceof HidError) {
      switch (error.code) {
        case "not_found":
          return new CliError("amp_not_found", error.message, "connect the amp with a USB cable and switch it on", Exit.ampNotFound);
        case "busy":
          return new CliError("amp_busy", error.message, "quit Fender Tone LT Desktop, then retry", Exit.ampBusy);
        case "permission":
          return new CliError("amp_permission", error.message, process.platform === "linux" ? "add a udev rule for 1ed8:* (see README), then replug the amp" : undefined, Exit.ampBusy);
        case "unsupported_platform":
          return new CliError("unsupported_platform", error.message, undefined, Exit.failure);
        default:
          return new CliError("amp_io", error.message, "reconnect the amp and retry", Exit.ampError);
      }
    }
    if (error instanceof AmpError) {
      switch (error.code) {
        case "timeout":
          return new CliError("amp_timeout", error.message, "retry; nothing was changed unless the output says so", Exit.ampError);
        case "invalid":
          return new CliError("invalid_input", error.message, undefined, Exit.usage);
        default:
          return new CliError(`amp_${error.code}`, error.message, undefined, Exit.ampError);
      }
    }
    return new CliError("error", error instanceof Error ? error.message : String(error), undefined, Exit.failure);
  }

  report(): void {
    if (out.json) out.emit({ error: { code: this.code, message: this.message, hint: this.hint ?? null, exitCode: this.exit } });
    else process.stderr.write(`${out.accent("error:")} ${this.message}\n${this.hint ? `hint: ${this.hint}\n` : ""}`);
  }
}

export const usageError = (message: string, hint?: string) => new CliError("usage", message, hint, Exit.usage);

// ---------------------------------------------------------------- catalog

let catalogCache: Catalog | null | undefined;

export function catalog(): Catalog | undefined {
  if (catalogCache === undefined) catalogCache = Catalog.load() ?? null;
  return catalogCache ?? undefined;
}

export function requireCatalog(): Catalog {
  const c = catalog();
  if (!c) {
    throw new CliError(
      "catalog_missing",
      "The amp and effect catalogue (catalog.json) is not installed.",
      "run `ltctl setup` once (it reads your copy of Fender Tone LT Desktop), or set TONELT_CATALOG",
      Exit.notFound,
    );
  }
  return c;
}

// ---------------------------------------------------------------- amp sessions

/**
 * Connects (SYNC_BEGIN + identity), runs `body`, then ends sync and stops reading. The
 * device handle itself is released when the process exits (main always exits right after),
 * which saves hidapi's ~40 ms reader-thread shutdown on every command.
 */
export async function withAmp<T>(body: (amp: AmpClient) => Promise<T>): Promise<T> {
  const amp = new AmpClient();
  if (out.verbose) amp.log = (line) => process.stderr.write(out.dim(`usb ${line}`) + "\n");
  await amp.connect();
  try {
    return await body(amp);
  } finally {
    await amp.close(false);
  }
}

// ---------------------------------------------------------------- preset references

export type PresetRef =
  | { kind: "slot"; slot: number }
  | { kind: "current" }
  | { kind: "factory"; name: string }
  | { kind: "file"; path: string }
  | { kind: "stdin" };

export const REF_HELP = "slot number (1-60), current, factory:<name>, a .preset file, or - for stdin";

export function parseRef(text: string): PresetRef {
  const t = text.trim();
  if (t === "-") return { kind: "stdin" };
  if (t.toLowerCase() === "current") return { kind: "current" };
  if (/^factory:/i.test(t)) return { kind: "factory", name: t.slice(8) };
  const n = /^(?:slot:)?(\d+)$/i.exec(t);
  if (n) {
    const slot = Number(n[1]);
    if (slot < 1 || slot > SLOT_COUNT) throw new CliError("invalid_slot", `Slot ${slot} does not exist.`, "slots are 1–60", Exit.usage);
    return { kind: "slot", slot };
  }
  return { kind: "file", path: t };
}

export function parseSlot(text: string | undefined, what = "slot"): number {
  const n = Number(text);
  if (text === undefined || !Number.isInteger(n) || n < 1 || n > SLOT_COUNT) {
    throw usageError(`${what} must be a number from 1 to ${SLOT_COUNT}${text === undefined ? "" : `, not "${text}"`}.`);
  }
  return n;
}

export const refNeedsAmp = (ref: PresetRef, cached = false) => ref.kind === "current" || (ref.kind === "slot" && !cached);

export function describeRef(ref: PresetRef): string {
  switch (ref.kind) {
    case "slot": return `slot ${ref.slot}`;
    case "current": return "the amp's current preset";
    case "factory": return `factory preset "${ref.name}"`;
    case "file": return ref.path;
    case "stdin": return "stdin";
  }
}

let stdinText: string | undefined;
export function readStdin(): string {
  stdinText ??= readFileSync(0, "utf8");
  return stdinText;
}

export async function loadRef(ref: PresetRef, amp: AmpClient | undefined, cached = false): Promise<Preset> {
  switch (ref.kind) {
    case "slot": {
      if (cached) {
        const entry = PresetCache.load().presets.get(ref.slot);
        if (!entry) throw new CliError("not_cached", `Slot ${ref.slot} has not been read yet.`, "run without --cached", Exit.notFound);
        return entry.preset;
      }
      if (!amp) throw usageError(`${describeRef(ref)} needs the amp`);
      return amp.readPreset(ref.slot);
    }
    case "current":
      if (!amp) throw usageError("current needs the amp");
      return (await amp.current()).preset;
    case "factory": {
      const presets = requireCatalog().factoryPresets;
      const q = normalize(ref.name);
      const exact = presets.find((p) => normalize(p.displayName) === q || normalize(p.rawName) === q);
      if (exact) return exact;
      const partial = presets.filter((p) => normalize(p.displayName).includes(q));
      if (partial.length === 1) return partial[0]!;
      throw new CliError(
        "not_found",
        `No single factory preset matches "${ref.name}".`,
        partial.length ? `matches: ${partial.map((p) => p.displayName).join(", ")}` : "see `ltctl factory`",
        Exit.notFound,
      );
    }
    case "file": {
      const path = resolve(ref.path.replace(/^~(?=$|\/|\\)/, process.env.HOME ?? "~"));
      try {
        return readPresetFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CliError("not_found", `No such file: ${ref.path}`, undefined, Exit.notFound);
        throw new CliError("invalid_preset", `${ref.path} is not a preset: ${(error as Error).message}`, undefined, Exit.invalid);
      }
    }
    case "stdin":
      try {
        return Preset.parse(readStdin().trim(), undefined);
      } catch (error) {
        throw new CliError("invalid_preset", `stdin is not a preset: ${(error as Error).message}`, undefined, Exit.invalid);
      }
  }
}

/** Opens the amp only if one of the references needs it. */
export async function withRefs<T>(refs: PresetRef[], cached: boolean, body: (amp: AmpClient | undefined) => Promise<T>): Promise<T> {
  return refs.some((r) => refNeedsAmp(r, cached)) ? withAmp(body) : body(undefined);
}

export function expandPath(p: string): string {
  return resolve(p.replace(/^~(?=$|\/|\\)/, process.env.HOME ?? process.env.USERPROFILE ?? "~"));
}

export const pad = (s: string, width: number) => (s.length >= width ? s : s + " ".repeat(width - s.length));
export const slotLabel = (n: number | null | undefined) => (n == null ? "--" : String(n).padStart(2, "0"));
