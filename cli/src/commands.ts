// Every ltctl command. Each is described once here; help, completions and
// `ltctl commands --json` are generated from these specs.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AmpClient, SLOT_COUNT } from "./amp";
import { formatNumber, type ParamSpec, PASSTHRU, POSITIONS } from "./catalog";
import {
  catalog,
  CliError,
  describeRef,
  Exit,
  expandPath,
  loadRef,
  out,
  pad,
  parseRef,
  parseSlot,
  readStdin,
  REF_HELP,
  requireCatalog,
  slotLabel,
  usageError,
  withAmp,
  withRefs,
} from "./cli";
import { normalize, PresetEditor } from "./editor";
import { renderMarkdown } from "./markdown";
import { VERSION } from "./version";
import { Preset } from "./preset";
import { backup, backupDir, dataDir, exportAll, PRESET_EXTENSION, PresetCache, readPresetFile, snapshot, writePresetFile } from "./storage";
import { chainLine, type Change, diff, type PresetSummary, specAssignments, summarize } from "./summary";

export interface OptionSpec {
  type: "boolean" | "string";
  short?: string;
  value?: string;
  description: string;
}

export interface CommandSpec {
  name: string;
  aliases?: string[];
  summary: string;
  args?: string;
  description?: string;
  examples?: string[];
  options?: Record<string, OptionSpec>;
  /** "no" | "maybe" (depends on the preset reference) | "yes" */
  usesAmp: "no" | "maybe" | "yes";
  /** Changes the amp (always backed up, never without an explicit command). */
  changesAmp?: boolean;
  run(args: string[], opts: Record<string, any>): Promise<void>;
}

// ---------------------------------------------------------------- helpers

function describe(s: PresetSummary): string {
  const lines = [`${out.bold((s.slot ? `${slotLabel(s.slot)}  ` : "") + s.name)}${out.dim(`   "${s.ampName}"`)}`];
  for (const node of s.chain) {
    const label = pad(node.position.toUpperCase(), 7);
    if (node.empty) {
      lines.push(`${out.dim(label)} ${out.dim("-")}`);
      continue;
    }
    lines.push(`${out.dim(label)} ${out.bold(pad(node.unit, 13))} ${node.params.filter((p) => p.panel).map((p) => `${p.name.toLowerCase()} ${p.display}`).join(" · ")}`);
    const hidden = node.params.filter((p) => !p.panel).map((p) => `${p.name.toLowerCase()} ${p.display}`);
    if (hidden.length) lines.push(" ".repeat(22) + out.dim(hidden.join(" · ")));
  }
  return lines.join("\n");
}

/** What a parameter accepts, in display units: "1…10", "30…1000 ms", "-50…50 %". */
function valueRange(p: ParamSpec): string {
  if (p.hasDisplayRange) return `${formatNumber(p.remap!.min!)}…${formatNumber(p.remap!.max!)}${p.displayUnits ? " " + p.displayUnits : ""}`;
  return `${formatNumber(p.min ?? 0)}…${formatNumber(p.max ?? 1)}${p.rawUnits ? " " + p.rawUnits : ""}`;
}

const changeLine = (c: Change) => `${pad(c.key, 22)} ${c.from ?? "-"} → ${c.to ?? "-"}`;

function ensureValid(preset: Preset): void {
  const problems = preset.validate(catalog());
  if (problems.length) throw new CliError("invalid_preset", `The preset can't go on the amp: ${problems.join("; ")}.`, undefined, Exit.invalid);
}

/** Writes a slot and verifies it by reading it back. */
async function store(amp: AmpClient, preset: Preset, slot: number): Promise<void> {
  const stored = await amp.write(preset, slot);
  if (!stored.sameContent(preset)) {
    throw new CliError("verify_failed", `Slot ${slot} did not read back as written.`, `compare with \`ltctl diff ${slot} <file>\`; the previous contents are in ${backupDir()}`, Exit.ampError);
  }
}

async function loadSlot(amp: AmpClient, slot: number, discardEdits: boolean): Promise<void> {
  const current = await amp.current();
  if (current.dirty && !discardEdits) {
    throw new CliError("unsaved_edits", `The amp's active preset (${current.slot}) has unsaved edits.`, "save them on the amp, or pass --discard-edits", Exit.refused);
  }
  await amp.load(slot);
}

async function firstEmptySlot(amp: AmpClient): Promise<number> {
  const cached = PresetCache.load();
  if (cached.productId === amp.info?.productId) {
    const guess = [...cached.presets.keys()].sort((a, b) => a - b).find((s) => cached.presets.get(s)!.preset.isEmptySlot);
    if (guess && (await amp.readPreset(guess)).isEmptySlot) return guess;
  }
  for (let slot = 1; slot <= SLOT_COUNT; slot++) if ((await amp.readPreset(slot)).isEmptySlot) return slot;
  throw new CliError("no_empty_slot", "All 60 slots hold presets.", "use --slot <n> --replace", Exit.refused);
}

function specFrom(path: string): string[] {
  if (path === "-") return specAssignments(readStdin());
  let text: string;
  try {
    text = readFileSync(expandPath(path), "utf8");
  } catch {
    throw new CliError("not_found", `No such spec file: ${path}`, undefined, Exit.notFound);
  }
  return specAssignments(text);
}

function parseSlotList(text: string): number[] {
  const slots = new Set<number>();
  for (const part of text.split(",")) {
    const [a, b] = part.split("-").map((x) => x.trim());
    const first = parseSlot(a, "slot list");
    const last = b === undefined ? first : parseSlot(b, "slot list");
    if (last < first) throw usageError(`bad slot range "${part}"`);
    for (let s = first; s <= last; s++) slots.add(s);
  }
  return [...slots].sort((x, y) => x - y);
}

function writeOutput(preset: Preset, path: string): string | undefined {
  if (path === "-") {
    process.stdout.write(preset.json + "\n");
    return undefined;
  }
  const full = expandPath(path);
  writePresetFile(preset, full);
  return full;
}

const assignmentHelp = `Assignments (key=value, applied in order; values are what the amp shows):
  name=<text>                          two lines of 8 characters, e.g. "Spread Wings"
  stomp|mod|amp|delay|reverb=<unit>    menu name, FenderId or unique part (ac30); none = empty
  <position>.<parameter>=<value>       amp.gain=6.5  delay.time=400ms  amp.cabinet="2x12 blue"
  <position>.<parameter>=raw:<value>   exact stored value
Choosing a unit resets its parameters to defaults, so set parameters after it.
See \`ltctl units <unit>\` for a unit's parameters and options.`;

// ---------------------------------------------------------------- commands

export const commands: CommandSpec[] = [
  {
    name: "status",
    aliases: ["info"],
    summary: "Show the connected amp, its firmware and the active preset.",
    usesAmp: "yes",
    async run() {
      const result = await withAmp(async (amp) => {
        const current = await amp.current();
        return { ...amp.info!, currentSlot: current.slot, currentName: current.preset.displayName, edited: current.dirty };
      });
      if (out.json) return out.emit(result);
      out.line(`${out.bold(result.model)}  firmware ${result.firmware}`);
      out.line(`Preset  ${slotLabel(result.currentSlot)}  ${result.currentName}${result.edited ? out.accent("  (edited on the amp, not saved)") : ""}`);
    },
  },
  {
    name: "list",
    aliases: ["ls"],
    summary: "List the amp's 60 preset slots.",
    description: "Rows stream as they are read (~2 s for all 60 over USB). --cached answers instantly from the last read.",
    options: {
      cached: { type: "boolean", description: "Use the last read instead of USB (instant; may be stale)." },
      used: { type: "boolean", description: "Only slots holding a preset." },
      empty: { type: "boolean", description: "Only empty slots." },
    },
    examples: ["ltctl list", "ltctl list --empty --json", "ltctl ls --cached"],
    usesAmp: "maybe",
    async run(_args, opts) {
      const cat = catalog();
      const keep = (p: Preset) => (opts.used ? !p.isEmptySlot : opts.empty ? p.isEmptySlot : true);
      const row = (p: Preset, current?: number) => ({
        slot: p.slot!,
        name: p.isEmptySlot ? "Empty" : p.displayName,
        ampName: p.rawName,
        empty: p.isEmptySlot,
        current: p.slot === current,
        chain: p.isEmptySlot ? "" : chainLine(summarize(p, cat)),
      });
      const print = (r: ReturnType<typeof row>) =>
        out.line(`${r.current ? out.accent("▶") : " "}${slotLabel(r.slot)}  ${r.empty ? out.dim(pad("Empty", 18)) : pad(r.name, 18)} ${out.dim(r.chain)}`);

      if (opts.cached) {
        const cache = PresetCache.load();
        if (!cache.presets.size) throw new CliError("not_cached", "Nothing cached yet.", "run `ltctl list` once with the amp connected", Exit.notFound);
        const rows = [...cache.presets.keys()].sort((a, b) => a - b).map((s) => cache.presets.get(s)!.preset).filter(keep).map((p) => row(p));
        const oldest = new Date(Math.min(...[...cache.presets.values()].map((e) => e.readAt.getTime())));
        if (out.json) return out.emit({ cached: true, cachedAt: oldest.toISOString(), currentSlot: null, presets: rows });
        rows.forEach(print);
        out.note(out.dim(`(cached, last read ${oldest.toLocaleString()})`));
        return;
      }
      const rows = await withAmp(async (amp) => {
        const current = (await amp.current()).slot;
        const rows: ReturnType<typeof row>[] = [];
        await amp.readAll((p) => {
          if (!keep(p)) return;
          const r = row(p, current);
          rows.push(r);
          print(r);
        });
        return { rows, current };
      });
      if (out.json) out.emit({ cached: false, cachedAt: null, currentSlot: rows.current, presets: rows.rows });
    },
  },
  {
    name: "show",
    summary: "Describe a preset in the amp's own units (knob values, unit names).",
    args: "<preset>",
    description: `<preset> is a ${REF_HELP}.`,
    options: {
      raw: { type: "boolean", description: "Print the preset JSON exactly as stored." },
      cached: { type: "boolean", description: "Read amp slots from the cache instead of USB." },
    },
    examples: ["ltctl show 35", "ltctl show current --json", 'ltctl show "factory:Surf Music"', "ltctl show tone.preset --raw"],
    usesAmp: "maybe",
    async run(args, opts) {
      if (!args[0]) throw usageError("show needs a preset", "e.g. ltctl show 35");
      const ref = parseRef(args[0]);
      const preset = await withRefs([ref], opts.cached, (amp) => loadRef(ref, amp, opts.cached));
      if (opts.raw) return void process.stdout.write((out.stdoutTTY ? JSON.stringify(JSON.parse(preset.json), null, 2) : preset.json) + "\n");
      const s = summarize(preset, catalog());
      if (out.json) return out.emit(s);
      out.line(describe(s));
    },
  },
  {
    name: "diff",
    summary: "Compare two presets parameter by parameter.",
    args: "<preset> <preset>",
    description: 'Exits 0 whether or not they differ; check "identical" in --json output.',
    options: { cached: { type: "boolean", description: "Read amp slots from the cache instead of USB." } },
    examples: ["ltctl diff 35 ~/backup/35-old.preset", 'ltctl diff 1 "factory:Fender Clean" --json'],
    usesAmp: "maybe",
    async run(args, opts) {
      if (args.length !== 2) throw usageError("diff needs two presets");
      const [a, b] = args.map(parseRef) as [ReturnType<typeof parseRef>, ReturnType<typeof parseRef>];
      const [x, y] = await withRefs([a, b], opts.cached, async (amp) => [await loadRef(a, amp, opts.cached), await loadRef(b, amp, opts.cached)]);
      const changes = diff(summarize(x, catalog()), summarize(y, catalog()));
      if (out.json) return out.emit({ identical: changes.length === 0, changes });
      if (!changes.length) out.line("Identical.");
      changes.forEach((c) => out.line(changeLine(c)));
    },
  },
  {
    name: "pull",
    aliases: ["export-all"],
    summary: "Download the amp's presets into a folder as .preset files.",
    args: "[folder]",
    description: 'Writes "NN Name.preset" per used slot plus index.json (every slot, summarised). Older files for a slot are replaced. Default folder: ./amp-presets',
    options: {
      slots: { type: "string", value: "list", description: "Only these slots, e.g. 1-10,35." },
      "include-empty": { type: "boolean", description: "Also write empty slots." },
    },
    examples: ["ltctl pull ~/amp", "ltctl pull ~/amp --slots 30-40 --json"],
    usesAmp: "yes",
    async run(args, opts) {
      const dir = expandPath(args[0] ?? "amp-presets");
      const slots = opts.slots ? parseSlotList(opts.slots) : Array.from({ length: SLOT_COUNT }, (_, i) => i + 1);
      const { presets, model } = await withAmp(async (amp) => {
        let done = 0;
        const presets = await amp.readPresets(slots, () => out.progress(`Reading ${++done}/${slots.length}…`));
        out.endProgress();
        return { presets, model: amp.info!.model };
      });
      mkdirSync(dir, { recursive: true });
      const existing = readdirSync(dir);
      const files: { slot: number; name: string; path: string }[] = [];
      for (const p of presets) {
        if (p.isEmptySlot && !opts["include-empty"]) continue;
        const file = `${p.fileBaseName}.${PRESET_EXTENSION}`;
        const prefix = `${slotLabel(p.slot)} `;
        for (const old of existing) if (old.startsWith(prefix) && old.endsWith(`.${PRESET_EXTENSION}`) && old !== file) rmSync(join(dir, old));
        writePresetFile(p, join(dir, file));
        files.push({ slot: p.slot!, name: p.displayName, path: join(dir, file) });
      }
      const cat = catalog();
      writeFileSync(join(dir, "index.json"), JSON.stringify(presets.map((p) => summarize(p, cat)), null, 2));
      if (out.json) return out.emit({ folder: dir, model, files });
      out.line(`Pulled ${files.length} presets from the ${model} into ${dir}`);
    },
  },
  {
    name: "export",
    summary: "Save one preset as a .preset file.",
    args: "<preset>",
    options: { output: { type: "string", short: "o", value: "file", description: 'Output file or - for stdout (default "NN Name.preset").' } },
    examples: ["ltctl export 35", "ltctl export 35 -o queen.preset", 'ltctl export "factory:Surf Music" -o -'],
    usesAmp: "maybe",
    async run(args, opts) {
      if (!args[0]) throw usageError("export needs a preset");
      const ref = parseRef(args[0]);
      const preset = await withRefs([ref], false, (amp) => loadRef(ref, amp));
      const path = writeOutput(preset, opts.output ?? `${preset.fileBaseName}.${PRESET_EXTENSION}`);
      if (!path) return;
      if (out.json) return out.emit({ path, name: preset.displayName });
      out.line(`Saved "${preset.displayName}" to ${path}`);
    },
  },
  {
    name: "backup",
    summary: "Snapshot every used slot into the backup folder (or a folder you name).",
    args: "[folder]",
    usesAmp: "yes",
    async run(args) {
      const presets = await withAmp((amp) => amp.readAll((p) => out.progress(`Reading ${p.slot}/${SLOT_COUNT}…`)));
      out.endProgress();
      const used = presets.filter((p) => !p.isEmptySlot);
      let folder: string;
      if (args[0]) {
        folder = expandPath(args[0]);
        exportAll(used, folder);
      } else folder = snapshot(used, "manual backup");
      if (out.json) return out.emit({ folder, count: used.length });
      out.line(`Backed up ${used.length} presets to ${folder}`);
    },
  },
  {
    name: "new",
    summary: "Create a preset from assignments, in the amp's own units.",
    args: "[name] [key=value…]",
    description: `Starts from the amp's EMPTY template (or --from another preset). Writes JSON to stdout unless -o is given.\n\n${assignmentHelp}`,
    options: {
      from: { type: "string", value: "preset", description: "Start from this preset (slot, factory:<name>, file)." },
      spec: { type: "string", value: "file", description: "Apply a JSON tone spec (file or -) before the assignments." },
      output: { type: "string", short: "o", value: "file", description: "Output file, or - for stdout (default)." },
    },
    examples: [
      'ltctl new "Brighton Rock" amp=ac30 amp.gain=7 stomp=overdrive stomp.gain=2.5 delay=delay delay.time=800ms -o brighton.preset',
      'ltctl new --from 35 name="Solo Boost" amp.gain=7.5 | ltctl push - --slot empty',
      "ltctl new --spec tone.json -o tone.preset",
    ],
    usesAmp: "maybe",
    async run(args, opts) {
      const cat = requireCatalog();
      let editor: PresetEditor;
      if (opts.from) {
        const ref = parseRef(opts.from);
        editor = new PresetEditor(cat, await withRefs([ref], false, (amp) => loadRef(ref, amp)));
      } else editor = new PresetEditor(cat);
      const assignments = opts.spec ? specFrom(opts.spec) : [];
      const rest = [...args];
      if (rest[0] && !rest[0].includes("=")) assignments.unshift(`name=${rest.shift()}`);
      for (const a of [...assignments, ...rest]) editor.apply(a);
      const preset = editor.preset();
      if (!opts.from && preset.isEmptySlot) throw new CliError("invalid_input", "The new preset needs a name.", 'e.g. ltctl new "Spread Wings" amp=ac30 …', Exit.invalid);
      ensureValid(preset);
      const path = writeOutput(preset, opts.output ?? "-");
      if (!path) return;
      const s = summarize(preset, cat);
      if (out.json) return out.emit({ path, preset: s });
      out.line(`Created ${path}`);
      out.line(describe(s));
    },
  },
  {
    name: "set",
    summary: "Change parameters of an amp slot or a preset file.",
    args: "<preset> <key=value…>",
    description: `On a slot, the slot is backed up and rewritten; on a file, the file is updated (or written to -o).\n\n${assignmentHelp}`,
    options: {
      spec: { type: "string", value: "file", description: "Apply a JSON tone spec (file or -) first." },
      output: { type: "string", short: "o", value: "file", description: "Write the result here (file or -) instead of back to the source." },
      "dry-run": { type: "boolean", description: "Show the changes without writing anything." },
    },
    examples: ["ltctl set 35 amp.gain=7 reverb.level=3", "ltctl set 35 delay=none --dry-run", "ltctl set tone.preset amp=\"deluxe cln\" amp.volume=8 -o tone2.preset"],
    usesAmp: "maybe",
    changesAmp: true,
    async run(args, opts) {
      const cat = requireCatalog();
      const [target, ...rest] = args;
      if (!target) throw usageError("set needs a preset and assignments", "e.g. ltctl set 35 amp.gain=7");
      const assignments = [...(opts.spec ? specFrom(opts.spec) : []), ...rest];
      if (!assignments.length) throw usageError("Nothing to change.", "add assignments like amp.gain=7");
      const ref = parseRef(target);
      if (ref.kind === "current") throw usageError("`set` edits stored presets.", "use the active slot's number instead of current");
      const edit = (original: Preset) => {
        const editor = new PresetEditor(cat, original);
        for (const a of assignments) editor.apply(a);
        const edited = editor.preset(original.slot);
        ensureValid(edited);
        return { edited, changes: diff(summarize(original, cat), summarize(edited, cat)) };
      };
      const report = (r: { target: string; dryRun: boolean; changes: Change[]; backup: string | null }) => {
        if (out.json) return out.emit(r);
        if (!r.changes.length) return out.line("No changes.");
        r.changes.forEach((c) => out.line(changeLine(c)));
        out.line(r.dryRun ? out.dim("(dry run: nothing written)") : `Updated ${r.target}.`);
        if (r.backup) out.note(out.dim(`Backup: ${r.backup}`));
      };
      if (ref.kind === "slot" && !opts.output) {
        const result = await withAmp(async (amp) => {
          const original = await amp.readPreset(ref.slot);
          const { edited, changes } = edit(original);
          if (opts["dry-run"] || !changes.length) return { target: `slot ${ref.slot}`, dryRun: !!opts["dry-run"], changes, backup: null };
          const saved = backup(original, `before set on slot ${ref.slot}`);
          await store(amp, edited, ref.slot);
          return { target: `slot ${ref.slot}`, dryRun: false, changes, backup: saved };
        });
        return report(result);
      }
      const original = await withRefs([ref], false, (amp) => loadRef(ref, amp));
      const { edited, changes } = edit(original);
      const destination = opts.output ?? (ref.kind === "file" ? ref.path : undefined);
      if (!destination) throw usageError("Where should the result go?", "add -o <file> or -o -");
      if (opts["dry-run"]) return report({ target: destination, dryRun: true, changes, backup: null });
      const written = writeOutput(edited, destination);
      if (written) report({ target: written, dryRun: false, changes, backup: null });
    },
  },
  {
    name: "push",
    aliases: ["import"],
    summary: "Store a preset in an amp slot.",
    args: "<preset>",
    description: "Refuses to replace a slot that holds a preset unless --replace is given. Anything replaced is backed up, and the slot is read back to verify.",
    options: {
      slot: { type: "string", value: "n|empty", description: 'Target slot 1-60, or "empty" for the first empty slot. Required.' },
      replace: { type: "boolean", description: "Allow replacing a slot that holds a preset." },
      "dry-run": { type: "boolean", description: "Show what would happen without writing." },
      load: { type: "boolean", description: "Switch the amp to the slot afterwards." },
    },
    examples: [
      "ltctl push brighton.preset --slot empty",
      "ltctl push brighton.preset --slot 50 --dry-run",
      'ltctl push "factory:Surf Music" --slot 51 --load',
      "ltctl push 35 --slot 52                  # copy slot 35 to 52",
      "ltctl new … | ltctl push - --slot 35 --replace",
    ],
    usesAmp: "yes",
    changesAmp: true,
    async run(args, opts) {
      if (!args[0]) throw usageError("push needs a preset");
      if (!opts.slot) throw usageError("push needs --slot <n|empty>");
      const ref = parseRef(args[0]);
      const target = String(opts.slot).toLowerCase() === "empty" ? undefined : parseSlot(opts.slot);
      if (ref.kind !== "slot" && ref.kind !== "current") ensureValid(await loadRef(ref, undefined));
      const result = await withAmp(async (amp) => {
        const incoming = await loadRef(ref, amp);
        ensureValid(incoming);
        const slot = target ?? (await firstEmptySlot(amp));
        const existing = await amp.readPreset(slot);
        if (!existing.isEmptySlot && !opts.replace && !opts["dry-run"]) {
          throw new CliError("slot_not_empty", `Slot ${slot} holds "${existing.displayName}".`, "pass --replace to overwrite it (it is backed up first), or use --slot empty", Exit.refused);
        }
        const replaced = existing.isEmptySlot ? null : existing.displayName;
        if (opts["dry-run"]) return { slot, name: incoming.displayName, replaced, dryRun: true, needsReplace: !!replaced && !opts.replace, backup: null, loaded: false };
        const saved = replaced ? backup(existing, `before push to slot ${slot}`) : null;
        await store(amp, incoming, slot);
        if (opts.load) await loadSlot(amp, slot, false);
        return { slot, name: incoming.displayName, replaced, dryRun: false, backup: saved, loaded: !!opts.load };
      });
      if (out.json) return out.emit(result);
      const what = result.replaced ? `, replacing "${result.replaced}"` : "";
      out.line(`${result.dryRun ? "Would store" : "Stored"} "${result.name}" in slot ${result.slot}${what}.`);
      if ("needsReplace" in result && result.needsReplace) out.line(out.dim("(needs --replace)"));
      if (result.backup) out.note(out.dim(`Backup: ${result.backup}`));
    },
  },
  {
    name: "rename",
    summary: "Rename a preset on the amp.",
    args: "<slot> <name>",
    description: "Names are two lines of 8 characters (letters, digits, spaces).",
    options: { "dry-run": { type: "boolean", description: "Show the result without writing." } },
    examples: ['ltctl rename 35 "Spread Wings"'],
    usesAmp: "yes",
    changesAmp: true,
    async run(args, opts) {
      const slot = parseSlot(args[0]);
      if (!args[1]) throw usageError("rename needs a name");
      const cat = requireCatalog();
      const result = await withAmp(async (amp) => {
        const original = await amp.readPreset(slot);
        if (original.isEmptySlot) throw new CliError("slot_empty", `Slot ${slot} is empty.`, "push a preset there first", Exit.refused);
        const editor = new PresetEditor(cat, original);
        editor.setName(args.slice(1).join(" "));
        const renamed = editor.preset(slot);
        let saved: string | null = null;
        if (!opts["dry-run"]) {
          saved = backup(original, `before rename of slot ${slot}`);
          await store(amp, renamed, slot);
        }
        return { slot, from: original.displayName, to: renamed.displayName, ampName: renamed.rawName, dryRun: !!opts["dry-run"], backup: saved };
      });
      if (out.json) return out.emit(result);
      out.line(`${result.dryRun ? "Would rename" : "Renamed"} slot ${slot}: ${result.from} → ${result.to}  ${out.dim(`"${result.ampName}"`)}`);
    },
  },
  {
    name: "swap",
    summary: "Swap the presets in two slots (both backed up first).",
    args: "<slot> <slot>",
    options: { "dry-run": { type: "boolean", description: "Show the result without writing." } },
    usesAmp: "yes",
    changesAmp: true,
    async run(args, opts) {
      const a = parseSlot(args[0]);
      const b = parseSlot(args[1]);
      if (a === b) throw usageError("Pick two different slots.");
      const [x, y, backups] = await withAmp(async (amp) => {
        const x = await amp.readPreset(a);
        const y = await amp.readPreset(b);
        const backups: string[] = [];
        if (!opts["dry-run"]) {
          backups.push(backup(x, `before swap ${a}-${b}`), backup(y, `before swap ${a}-${b}`));
          await store(amp, y, a);
          await store(amp, x, b);
        }
        return [x, y, backups] as const;
      });
      const name = (p: Preset) => (p.isEmptySlot ? "Empty" : p.displayName);
      if (out.json) return out.emit({ dryRun: !!opts["dry-run"], slots: { [a]: name(y), [b]: name(x) }, backups });
      out.line(`${opts["dry-run"] ? "Would put" : "Now"} ${slotLabel(a)} ${name(y)}, ${slotLabel(b)} ${name(x)}`);
    },
  },
  {
    name: "clear",
    summary: "Empty a slot (the preset is backed up first). Requires --yes.",
    args: "<slot>",
    options: { yes: { type: "boolean", description: "Confirm clearing the slot." } },
    examples: ["ltctl clear 60 --yes"],
    usesAmp: "yes",
    changesAmp: true,
    async run(args, opts) {
      const slot = parseSlot(args[0]);
      const cat = requireCatalog();
      const result = await withAmp(async (amp) => {
        const existing = await amp.readPreset(slot);
        if (existing.isEmptySlot) return { slot, cleared: null, backup: null };
        if (!opts.yes) throw new CliError("confirmation_required", `Clearing slot ${slot} removes "${existing.displayName}".`, "pass --yes (a backup is saved first)", Exit.refused);
        const saved = backup(existing, `before clear of slot ${slot}`);
        await store(amp, Preset.parse(cat.emptyPresetJSON, slot), slot); // the amp's own EMPTY template
        return { slot, cleared: existing.displayName, backup: saved };
      });
      if (out.json) return out.emit(result);
      out.line(result.cleared ? `Cleared slot ${slot} (was "${result.cleared}").` : `Slot ${slot} was already empty.`);
    },
  },
  {
    name: "restore",
    summary: "Write a pulled or backed-up folder back to the amp (only slots that differ).",
    args: "<folder>",
    description: 'Reads "NN Name.preset" files, compares each with the amp and rewrites the slots that differ, after snapshotting the whole amp. Requires --yes unless --dry-run.',
    options: {
      "dry-run": { type: "boolean", description: "Only report what would change." },
      yes: { type: "boolean", description: "Confirm writing to the amp." },
    },
    examples: ["ltctl restore ~/amp --dry-run", "ltctl restore ~/amp --yes"],
    usesAmp: "yes",
    changesAmp: true,
    async run(args, opts) {
      if (!args[0]) throw usageError("restore needs a folder");
      const dir = expandPath(args[0]);
      const files = new Map<number, Preset>();
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        throw new CliError("not_found", `No such folder: ${args[0]}`, undefined, Exit.notFound);
      }
      for (const name of names) {
        const m = /^(\d\d) .*\.preset$/.exec(name);
        const slot = m ? Number(m[1]) : 0;
        if (slot >= 1 && slot <= SLOT_COUNT) files.set(slot, readPresetFile(join(dir, name)).withSlot(slot));
      }
      if (!files.size) throw new CliError("not_found", `No "NN Name.preset" files in ${dir}.`, undefined, Exit.notFound);
      files.forEach(ensureValid);
      const items = await withAmp(async (amp) => {
        const slots = [...files.keys()].sort((a, b) => a - b);
        const current = await amp.readPresets(slots);
        const changed = slots.map((s, i) => ({ slot: s, now: current[i]! })).filter(({ slot, now }) => !now.sameContent(files.get(slot)!));
        const items = changed.map(({ slot, now }) => ({ slot, from: now.isEmptySlot ? "Empty" : now.displayName, to: files.get(slot)!.displayName }));
        if (opts["dry-run"] || !items.length) return items;
        if (!opts.yes) throw new CliError("confirmation_required", `${items.length} slot(s) would be rewritten.`, "check with --dry-run, then pass --yes", Exit.refused);
        snapshot(current.filter((p) => !p.isEmptySlot), "before restore");
        for (const { slot } of changed) await store(amp, files.get(slot)!, slot);
        return items;
      });
      if (out.json) return out.emit({ dryRun: !!opts["dry-run"], changes: items });
      if (!items.length) return out.line("The amp already matches that folder.");
      items.forEach((i) => out.line(`${slotLabel(i.slot)}  ${i.from} → ${i.to}`));
      out.line(opts["dry-run"] ? out.dim("(dry run: nothing written)") : `Restored ${items.length} slot(s).`);
    },
  },
  {
    name: "load",
    summary: "Switch the amp to a stored preset.",
    args: "<slot>",
    options: { "discard-edits": { type: "boolean", description: "Switch even if the active preset has unsaved edits (they are lost)." } },
    usesAmp: "yes",
    async run(args, opts) {
      const slot = parseSlot(args[0]);
      const name = await withAmp(async (amp) => {
        await loadSlot(amp, slot, !!opts["discard-edits"]);
        return (await amp.current()).preset.displayName;
      });
      if (out.json) return out.emit({ slot, name });
      out.line(`Amp is on ${slotLabel(slot)} ${name}.`);
    },
  },
  {
    name: "audition",
    summary: "Play a preset on the amp without saving it.",
    args: "<preset> | --stop",
    description: "The amp plays it until another preset is chosen or --stop returns to the stored preset. Nothing is written to any slot.",
    options: { stop: { type: "boolean", description: "End the audition and reload the stored preset." } },
    examples: ["ltctl audition brighton.preset", 'ltctl audition "factory:Surf Music"', "ltctl audition --stop"],
    usesAmp: "yes",
    async run(args, opts) {
      if (opts.stop) {
        await withAmp((amp) => amp.exitAudition());
        if (out.json) return out.emit({ auditioning: null });
        return out.line("Audition ended.");
      }
      if (!args[0]) throw usageError("audition needs a preset, or --stop");
      const ref = parseRef(args[0]);
      const name = await withAmp(async (amp) => {
        const p = await loadRef(ref, amp);
        ensureValid(p);
        await amp.audition(p);
        return p.displayName;
      });
      if (out.json) return out.emit({ auditioning: name });
      out.line(`Playing "${name}" (not saved). \`ltctl audition --stop\` returns to the stored preset.`);
    },
  },
  {
    name: "units",
    aliases: ["catalog"],
    summary: "List the amps and effects the LT offers, or one unit's parameters.",
    args: "[position|unit]",
    examples: ["ltctl units", "ltctl units amp", "ltctl units ac30", "ltctl units delay --json"],
    usesAmp: "no",
    async run(args) {
      const cat = requireCatalog();
      const q = args.join(" ");
      const position = POSITIONS.find((p) => p === q.toLowerCase());
      if (!q || position) {
        const positions = position ? [position] : POSITIONS;
        const data = positions.map((p) => ({
          position: p,
          units: (cat.options.get(p) ?? []).map((o) => ({ unitId: o.fenderId, unit: o.menuName, name: cat.unit(o.fenderId)?.displayName ?? "" })),
        }));
        if (out.json) return out.emit({ source: cat.source, positions: data });
        for (const d of data) {
          out.line(out.bold(d.position.toUpperCase()));
          for (const u of d.units) out.line(`  ${pad(u.unit, 14)} ${out.dim(u.unitId === PASSTHRU ? "(empty)" : u.unitId)}`);
        }
        return;
      }
      // One unit: resolve against every position.
      const hits = POSITIONS.flatMap((p) => {
        try {
          const id = new PresetEditor(cat, undefined).resolveUnit(p, q);
          return id === PASSTHRU ? [] : [{ position: p, id }];
        } catch {
          return [];
        }
      });
      if (!hits.length) throw new CliError("not_found", `No unit matches "${q}".`, "see `ltctl units`", Exit.notFound);
      const units = hits.map(({ position, id }) => {
        const unit = cat.unit(id)!;
        return {
          position,
          unitId: id,
          unit: cat.menuName(id) ?? unit.displayName,
          name: unit.displayName,
          params: unit.params.filter((p) => p.id !== "bypassType").map((p) => ({
            id: p.id,
            key: `${position}.${p.id}`,
            name: p.displayName,
            panel: p.onPanel,
            kind: p.kind,
            range: p.kind === "continuous" ? valueRange(p) : null,
            rawRange: p.kind === "continuous" ? `${formatNumber(p.min ?? 0)}…${formatNumber(p.max ?? 1)}` : null,
            options: p.kind === "list" ? p.listItems.map((item, i) => ({ value: item, label: p.remap?.listItems[i] ?? item })) : p.kind === "listBool" ? [{ value: "off" }, { value: "on" }] : null,
            default: unit.defaults[p.id] === undefined ? null : p.display(unit.defaults[p.id]!),
          })),
        };
      });
      if (out.json) return out.emit({ units });
      for (const u of units) {
        out.line(`${out.bold(u.unit)}  ${out.dim(`${u.unitId} · ${u.position}`)}`);
        for (const p of u.params) {
          const values = p.options ? p.options.map((o: any) => o.value).join(" | ") : p.range;
          const key = normalize(p.name) === normalize(p.id) ? p.key : `${p.key} (${p.name.toLowerCase()})`;
          out.line(`  ${pad(key, 30)} ${pad(values ?? "", 20)} ${out.dim(`${p.default ? `default ${p.default}` : ""}${p.panel ? "" : "  · advanced"}`)}`);
        }
      }
    },
  },
  {
    name: "factory",
    summary: "List Fender's factory preset library (use as factory:<name>).",
    args: "[search]",
    examples: ["ltctl factory", "ltctl factory fuzz --json", 'ltctl show "factory:Surf Music"'],
    usesAmp: "no",
    async run(args) {
      const cat = requireCatalog();
      const q = args.join(" ").toLowerCase();
      const rows = cat.factoryPresets
        .filter((p) => !q || p.displayName.toLowerCase().includes(q) || chainLine(summarize(p, cat)).toLowerCase().includes(q))
        .map((p) => ({ name: p.displayName, ref: `factory:${p.displayName}`, chain: chainLine(summarize(p, cat)) }));
      if (out.json) return out.emit({ presets: rows });
      rows.forEach((r) => out.line(`${pad(r.name, 20)} ${out.dim(r.chain)}`));
    },
  },
  {
    name: "validate",
    summary: "Check preset files before pushing them.",
    args: "<preset…>",
    usesAmp: "maybe",
    async run(args) {
      if (!args.length) throw usageError("validate needs at least one preset");
      const refs = args.map(parseRef);
      const results = await withRefs(refs, false, async (amp) => {
        const results: { preset: string; name: string | null; ok: boolean; problems: string[] }[] = [];
        for (const ref of refs) {
          try {
            const p = await loadRef(ref, amp);
            const problems = p.validate(catalog());
            results.push({ preset: describeRef(ref), name: p.displayName, ok: !problems.length, problems });
          } catch (error) {
            results.push({ preset: describeRef(ref), name: null, ok: false, problems: [CliError.from(error).message] });
          }
        }
        return results;
      });
      if (out.json) out.emit({ ok: results.every((r) => r.ok), results });
      else for (const r of results) out.line(r.ok ? `ok  ${r.preset} (“${r.name}”)` : `${out.accent("✗")}   ${r.preset}: ${r.problems.join("; ")}`);
      if (!results.every((r) => r.ok)) process.exitCode = Exit.invalid;
    },
  },
  {
    name: "markdown",
    summary: "Write the agent reference: every amp/effect, parameters, and the amp's presets.",
    args: "[file]",
    description: "Writes to stdout unless a file is given. Reads the amp's presets if it is connected.",
    options: {
      "no-factory": { type: "boolean", description: "Leave out Fender's 100-preset factory library." },
      offline: { type: "boolean", description: "Don't read the amp (uses cached presets if any)." },
    },
    usesAmp: "maybe",
    async run(args, opts) {
      const cat = requireCatalog();
      let presets: Preset[] = [];
      let info;
      if (opts.offline) {
        const cache = PresetCache.load();
        presets = [...cache.presets.keys()].sort((a, b) => a - b).map((s) => cache.presets.get(s)!.preset);
      } else {
        try {
          ({ presets, info } = await withAmp(async (amp) => ({ presets: await amp.readAll((p) => out.progress(`Reading ${p.slot}/${SLOT_COUNT}…`)), info: amp.info })));
          out.endProgress();
        } catch (error) {
          const e = CliError.from(error);
          if (e.exit !== Exit.ampNotFound) throw e;
          out.note("No amp connected; writing the reference without its presets.");
        }
      }
      const text = renderMarkdown(cat, presets, info, { factory: !opts["no-factory"] });
      if (!args[0] || args[0] === "-") return void process.stdout.write(text + "\n");
      writeFileSync(expandPath(args[0]), text);
      if (out.json) return out.emit({ path: expandPath(args[0]), bytes: text.length });
      out.line(`Wrote ${expandPath(args[0])}`);
    },
  },
  {
    name: "setup",
    summary: "Install the amp and effect catalogue from your copy of Fender Tone LT Desktop.",
    args: "[app|dmg|catalog.json]",
    description:
      "Reads the amp and effect definitions and Fender's factory presets out of Fender Tone LT Desktop " +
      "(the installed app or its installer .dmg, on macOS) and saves them as catalog.json for this user. " +
      "With no argument it looks in /Applications, ~/Applications, ~/Downloads and ~/Desktop. " +
      "On Windows or Linux, run setup on a Mac and pass the resulting catalog.json. " +
      "The catalogue is saved to ~/Library/Application Support/ToneLT (macOS), ~/.local/share/tonelt (Linux) " +
      "or %APPDATA%\\ToneLT (Windows); `ltctl doctor` shows where. Nothing from Fender is shipped with ltctl.",
    options: { output: { type: "string", short: "o", value: "file", description: "Write catalog.json here instead of installing it." } },
    examples: ["ltctl setup", 'ltctl setup "/Applications/Fender Tone LT Desktop.app"', 'ltctl setup "~/Downloads/Fender Tone App.dmg"', "ltctl setup catalog.json"],
    usesAmp: "no",
    async run(args, opts) {
      const { extractCatalog, ExtractError, findFenderApp } = await import("./extract");
      const source = args[0] ? expandPath(args.join(" ")) : findFenderApp();
      if (!source) {
        throw new CliError(
          "not_found",
          "Fender Tone LT Desktop was not found.",
          "download it from fender.com (it's free), then run `ltctl setup <path to the app or .dmg>`; on Windows or Linux pass a catalog.json made on a Mac",
          Exit.notFound,
        );
      }
      let catalogJSON: any;
      if (source.toLowerCase().endsWith(".json")) {
        try {
          catalogJSON = JSON.parse(readFileSync(source, "utf8"));
        } catch {
          throw new CliError("invalid_input", `${source} is not a catalog.json`, undefined, Exit.invalid);
        }
        if (!catalogJSON.dspUnits || !catalogJSON.productProfile) throw new CliError("invalid_input", `${source} is not a catalog.json`, undefined, Exit.invalid);
      } else {
        out.note(`Reading ${source}…`);
        try {
          catalogJSON = extractCatalog(source);
        } catch (error) {
          if (error instanceof ExtractError) throw new CliError("extract_failed", `Could not read the catalogue: ${error.message}.`, undefined, Exit.invalid);
          throw error;
        }
      }
      const dest = opts.output ? expandPath(opts.output) : join(dataDir(), "catalog.json");
      if (!opts.output) mkdirSync(dataDir(), { recursive: true });
      writeFileSync(dest, JSON.stringify(catalogJSON));
      const units = Object.keys(catalogJSON.dspUnits).length;
      const factory = (catalogJSON.factoryPresets ?? []).length;
      if (out.json) return out.emit({ installed: dest, source: catalogJSON.source, units, factoryPresets: factory });
      out.line(`${opts.output ? "Wrote" : "Installed"} the catalogue from ${catalogJSON.source}: ${units} amps and effects, ${factory} factory presets.`);
      out.line(out.dim(dest));
    },
  },
  {
    name: "doctor",
    summary: "Check the catalogue, USB access and the amp connection.",
    description: "Prints what ltctl can find and use. Include its output when reporting a problem.",
    usesAmp: "maybe",
    async run() {
      const { findAmps } = await import("./hid");
      const cat = catalog();
      const report: Record<string, unknown> = {
        version: VERSION,
        platform: `${process.platform}-${process.arch}`,
        catalog: cat ? { path: cat.path, source: cat.source } : null,
        dataFolder: dataDir(),
        backups: backupDir(),
      };
      const checks: [string, boolean, string][] = [];
      checks.push(["catalogue", !!cat, cat ? `${cat.source} (${cat.path})` : "missing: run `ltctl setup`"]);
      let amps: Awaited<ReturnType<typeof findAmps>> = [];
      try {
        amps = await findAmps();
        checks.push(["usb", true, "HID access works"]);
      } catch (error) {
        checks.push(["usb", false, CliError.from(error).message]);
      }
      report.amps = amps.map((a) => ({ name: a.name, productId: `0x${a.productId.toString(16).padStart(4, "0")}` }));
      checks.push(["amp found", amps.length > 0, amps.length ? amps.map((a) => a.name).join(", ") : "none: connect the amp with USB and switch it on"]);
      if (amps.length) {
        try {
          const info = await withAmp(async (amp) => amp.info!);
          report.amp = info;
          checks.push(["amp answers", true, `${info.model}, firmware ${info.firmware}`]);
        } catch (error) {
          const e = CliError.from(error);
          checks.push(["amp answers", false, `${e.message}${e.hint ? ` (${e.hint})` : ""}`]);
        }
      }
      report.checks = checks.map(([name, ok, detail]) => ({ name, ok, detail }));
      if (out.json) return out.emit(report);
      out.line(`ltctl ${VERSION} on ${process.platform}-${process.arch}`);
      for (const [name, ok, detail] of checks) out.line(`${ok ? "ok " : out.accent("✗  ")} ${pad(name, 12)} ${detail}`);
      if (checks.some(([, ok]) => !ok)) process.exitCode = Exit.failure;
    },
  },
];
