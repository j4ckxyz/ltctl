// Regenerates docs/COMMANDS.md from the command table, so the reference always matches
// `ltctl <command> --help`.   bun run docs
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { out } from "../src/cli";
import { commands } from "../src/commands";
import { GLOBAL_OPTIONS, GUIDE } from "../src/help";

out.color = false;
const groups: [string, string[]][] = [
  ["Reading", ["status", "list", "show", "diff", "pull", "export", "backup"]],
  ["Creating and editing presets", ["new", "set"]],
  ["Changing the amp", ["push", "rename", "swap", "clear", "restore", "load", "audition"]],
  ["Reference", ["units", "factory", "validate", "markdown"]],
  ["Setup", ["setup", "doctor"]],
];

const lines: string[] = [
  "# Command reference",
  "",
  "Generated from the command table (`bun run docs`); the same text as `ltctl <command> --help`.",
  "",
  "## Options for every command",
  "",
  "| Option | Description |",
  "|---|---|",
  ...Object.entries(GLOBAL_OPTIONS).map(([name, o]) => `| ${o.short ? `\`-${o.short}\`, ` : ""}\`--${name}\` | ${o.description} |`),
  "",
];
for (const [title, names] of groups) {
  lines.push(`## ${title}`, "");
  for (const name of names) {
    const c = commands.find((x) => x.name === name)!;
    lines.push(`### ltctl ${c.name}`, "", c.summary, "", "```", `ltctl ${c.name}${c.args ? ` ${c.args}` : ""} [options]`, "```", "");
    if (c.aliases?.length) lines.push(`Aliases: ${c.aliases.map((a) => `\`${a}\``).join(", ")}`, "");
    if (c.description) lines.push(c.description.replace(/\n/g, "\n\n").replace(/\n\n(  )/g, "\n$1"), "");
    const opts = Object.entries(c.options ?? {});
    if (opts.length) {
      lines.push("| Option | Description |", "|---|---|");
      for (const [n, o] of opts) lines.push(`| ${o.short ? `\`-${o.short}\`, ` : ""}\`--${n}${o.type === "string" ? ` <${o.value ?? "value"}>` : ""}\` | ${o.description} |`);
      lines.push("");
    }
    lines.push(`Uses the amp: ${c.usesAmp === "maybe" ? "only for amp slots or `current`" : c.usesAmp}. Changes the amp: ${c.changesAmp ? "yes (backed up and verified)" : "no"}.`, "");
    if (c.examples?.length) lines.push("```sh", ...c.examples, "```", "");
  }
}
lines.push("## The guide (`ltctl guide`)", "", "```", GUIDE.trimEnd(), "```", "");
writeFileSync(join(import.meta.dir, "../../docs/COMMANDS.md"), lines.join("\n"));
console.log("wrote docs/COMMANDS.md");
