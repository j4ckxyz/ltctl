#!/usr/bin/env bun
// ltctl: command-line control of Fender Mustang LT amps over USB.

import { parseArgs, type ParseArgsConfig } from "node:util";
import { CliError, Exit, out, usageError } from "./cli";
import { commands } from "./commands";
import { commandHelp, commandsJSON, completions, GLOBAL_OPTIONS, GUIDE, mainHelp } from "./help";
import { VERSION } from "./version";

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    const target = rest[0] && commands.find((c) => c.name === rest[0] || c.aliases?.includes(rest[0]!));
    process.stdout.write((target ? commandHelp(target) : mainHelp()) + "\n");
    return Exit.ok;
  }
  if (name === "--version" || name === "version") {
    process.stdout.write(out.json ? JSON.stringify({ version: VERSION }) + "\n" : `ltctl ${VERSION}\n`);
    return Exit.ok;
  }
  if (name === "guide") {
    process.stdout.write(GUIDE);
    return Exit.ok;
  }
  if (name === "commands") {
    if (out.json || rest.includes("--json")) out.emit(commandsJSON());
    else for (const c of commands) process.stdout.write(`${c.name.padEnd(10)} ${c.summary}\n`);
    return Exit.ok;
  }
  if (name === "completions") {
    process.stdout.write(completions(rest[0]) + "\n");
    return Exit.ok;
  }

  const cmd = commands.find((c) => c.name === name || c.aliases?.includes(name));
  if (!cmd) {
    const near = commands.find((c) => c.name.startsWith(name.slice(0, 2)));
    throw usageError(`unknown command "${name}"`, near ? `did you mean \`ltctl ${near.name}\`? (ltctl --help lists commands)` : "run `ltctl --help` for commands");
  }

  const options = Object.fromEntries(
    Object.entries({ ...cmd.options, ...GLOBAL_OPTIONS }).map(([k, o]) => [k, { type: o.type, ...(o.short ? { short: o.short } : {}) }]),
  ) as ParseArgsConfig["options"];
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw usageError((error as Error).message.replace(/\. To specify.*$/s, ""), `see \`ltctl ${cmd.name} --help\``);
  }
  const values = parsed.values as Record<string, any>;
  if (values.help) {
    process.stdout.write(commandHelp(cmd) + "\n");
    return Exit.ok;
  }
  out.json ||= !!values.json;
  out.quiet = !!values.quiet;
  out.verbose = !!values.verbose;
  if (values["no-color"]) out.color = false;
  await cmd.run(parsed.positionals, values);
  return typeof process.exitCode === "number" ? process.exitCode : Exit.ok;
}

// No top-level await: bytecode-compiled executables don't support it.
main(process.argv.slice(2)).then(
  // Exit explicitly: the HID device is released by process exit (see withAmp).
  (code) => process.exit(code),
  (error) => {
    const e = CliError.from(error);
    e.report();
    process.exit(e.exit);
  },
);
