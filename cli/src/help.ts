// Help text, the agent guide, completions and the machine-readable command list, all
// generated from the command table in commands.ts.

import { out, usageError } from "./cli";
import { type CommandSpec, commands, type OptionSpec } from "./commands";
import { VERSION } from "./version";

export const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  json: { type: "boolean", description: "Print one JSON object on stdout (errors too)." },
  quiet: { type: "boolean", short: "q", description: "Print only essential output." },
  verbose: { type: "boolean", short: "v", description: "Log USB messages to stderr." },
  "no-color": { type: "boolean", description: "Disable colours (also NO_COLOR=1)." },
  help: { type: "boolean", short: "h", description: "Show help." },
};

export const GUIDE = `ltctl guide: using ltctl from scripts and agents

WORKFLOW
  ltctl setup                         once: install the amp and effect catalogue from Fender Tone LT Desktop
  ltctl doctor --json                 check the catalogue, USB access and the amp
  ltctl status --json                 is an amp connected? which preset is active?
  ltctl list --json                   all 60 slots (≈2 s); --cached is instant but may be stale
  ltctl show 35 --json                one preset with knob values in the amp's units
  ltctl units ac30                    a unit's parameters, ranges and options
  ltctl new "Name" amp=ac30 amp.gain=6.5 … -o x.preset    create a preset file
  ltctl audition x.preset             hear it (nothing saved); ltctl audition --stop
  ltctl push x.preset --slot empty    store it in the first empty slot
  ltctl set 35 amp.gain=7             edit a stored preset (backed up first)
  ltctl markdown ref.md               full reference: every unit and parameter, all presets

PRESET REFERENCES
  35 (slot 1-60) · current (the amp's live preset) · factory:<name> · path/to/file.preset · - (stdin)

ASSIGNMENTS (new, set)
  name=<text>                         two lines of 8 characters, letters/digits/spaces
  stomp|mod|amp|delay|reverb=<unit>   menu name ("60S UK CLN"), FenderId or unique part; none = empty
  <position>.<param>=<value>          display values: knobs 1–10, 400ms, +10%, on/off, list option names
  <position>.<param>=raw:<value>      exact stored value
  Choosing a unit resets its parameters, so set parameters after it. Errors list valid options.
  --spec file.json takes {"name": …, "amp": {"unit": "ac30", "gain": 6}, "delay": null} or \`show --json\` output.

OUTPUT
  --json: exactly one JSON object on stdout, for success and failure. Errors look like
  {"error": {"code": "slot_not_empty", "message": "…", "hint": "…", "exitCode": 6}}.
  Human text goes to stdout, progress and notes to stderr. Nothing ever prompts.

SAFETY
  Reads never change the amp. push refuses to replace a used slot without --replace; clear and
  restore need --yes; set/push/rename/swap/restore/clear back up what they replace
  (${"`"}ltctl backup${"`"} snapshots everything) and verify writes by reading the slot back.
  --dry-run shows what would happen. Only one program can use the amp at a time.

EXIT CODES
  0 ok · 1 unexpected error · 2 usage · 3 no amp connected · 4 amp busy/no permission
  5 invalid preset or input · 6 refused (needs --replace/--yes/--discard-edits) · 7 amp I/O or timeout (retry)
  8 not found (file, slot not cached, factory preset, unit, catalogue)
`;

function optionUsage(name: string, o: OptionSpec): string {
  return `${o.short ? `-${o.short}, ` : "    "}--${name}${o.type === "string" ? ` <${o.value ?? "value"}>` : ""}`;
}

export function commandHelp(cmd: CommandSpec): string {
  const lines = [`${cmd.summary}`, "", `${out.bold("Usage:")} ltctl ${cmd.name}${cmd.args ? ` ${cmd.args}` : ""} [options]`];
  if (cmd.aliases?.length) lines.push(`${out.bold("Aliases:")} ${cmd.aliases.join(", ")}`);
  if (cmd.description) lines.push("", cmd.description);
  const options = { ...cmd.options, ...GLOBAL_OPTIONS };
  lines.push("", out.bold("Options:"));
  for (const [name, o] of Object.entries(options)) lines.push(`  ${optionUsage(name, o).padEnd(28)} ${o.description}`);
  if (cmd.examples?.length) {
    lines.push("", out.bold("Examples:"));
    for (const e of cmd.examples) lines.push(`  ${e}`);
  }
  return lines.join("\n");
}

export function mainHelp(): string {
  const groups: [string, string[]][] = [
    ["Read", ["status", "list", "show", "diff", "pull", "export", "backup"]],
    ["Create & edit", ["new", "set"]],
    ["Change the amp", ["push", "rename", "swap", "clear", "restore", "load", "audition"]],
    ["Reference", ["units", "factory", "validate", "markdown"]],
    ["Setup", ["setup", "doctor"]],
  ];
  const lines = [
    `${out.bold("ltctl")} ${VERSION}: Fender Mustang LT presets over USB`,
    "",
    `${out.bold("Usage:")} ltctl <command> [arguments] [--json] [-q] [-v]`,
    "",
  ];
  for (const [title, names] of groups) {
    lines.push(out.bold(title));
    for (const name of names) {
      const cmd = commands.find((c) => c.name === name)!;
      lines.push(`  ${name.padEnd(10)} ${cmd.summary}`);
    }
    lines.push("");
  }
  lines.push(out.bold("More"), "  guide      How to use ltctl from scripts and agents (references, assignments, exit codes)", "  commands   Every command and option (--json for machine-readable)", "  completions <zsh|bash|fish>  Shell completion script", "");
  lines.push(out.bold("Examples:"), "  ltctl list", "  ltctl show 35", '  ltctl new "Spread Wings" amp=ac30 amp.gain=6 delay=none -o wings.preset', "  ltctl push wings.preset --slot empty", "", "Run `ltctl <command> --help` for details.");
  return lines.join("\n");
}

export function commandsJSON() {
  return {
    version: VERSION,
    globalOptions: GLOBAL_OPTIONS,
    commands: commands.map((c) => ({
      name: c.name,
      aliases: c.aliases ?? [],
      summary: c.summary,
      args: c.args ?? "",
      usesAmp: c.usesAmp,
      changesAmp: !!c.changesAmp,
      options: c.options ?? {},
      examples: c.examples ?? [],
    })),
  };
}

export function completions(shell: string | undefined): string {
  const names = [...commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]), "guide", "commands", "completions", "help"];
  const opts = (c: CommandSpec) => Object.keys({ ...c.options, ...GLOBAL_OPTIONS }).map((o) => `--${o}`);
  switch (shell) {
    case "zsh":
      return `#compdef ltctl
_ltctl() {
  if (( CURRENT == 2 )); then
    compadd -- ${names.join(" ")}
    return
  fi
  case "$words[2]" in
${commands.map((c) => `    ${[c.name, ...(c.aliases ?? [])].join("|")}) compadd -- ${opts(c).join(" ")}; _files ;;`).join("\n")}
    *) _files ;;
  esac
}
compdef _ltctl ltctl`;
    case "bash":
      return `_ltctl() {
  local cur=\${COMP_WORDS[COMP_CWORD]}
  if [[ $COMP_CWORD -eq 1 ]]; then COMPREPLY=($(compgen -W "${names.join(" ")}" -- "$cur")); return; fi
  case "\${COMP_WORDS[1]}" in
${commands.map((c) => `    ${[c.name, ...(c.aliases ?? [])].join("|")}) COMPREPLY=($(compgen -W "${opts(c).join(" ")}" -- "$cur") $(compgen -f -- "$cur")) ;;`).join("\n")}
  esac
}
complete -o filenames -F _ltctl ltctl`;
    case "fish":
      return [
        `complete -c ltctl -f -n "__fish_use_subcommand" -a "${names.join(" ")}"`,
        ...commands.map((c) => `complete -c ltctl -n "__fish_seen_subcommand_from ${[c.name, ...(c.aliases ?? [])].join(" ")}" -F ${Object.keys(c.options ?? {}).map((o) => `-l ${o}`).join(" ")}`),
      ].join("\n");
    default:
      throw usageError("completions needs a shell: zsh, bash or fish");
  }
}
