// End-to-end checks of the agent-facing contract (no amp needed).
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const main = join(import.meta.dir, "../src/main.ts");
const hasCatalog = existsSync(join(import.meta.dir, "../../build/catalog.json"));

function run(args: string[], stdin?: string) {
  const p = Bun.spawnSync(["bun", main, ...args], { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), env: { ...process.env, NO_COLOR: "1" } });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

describe("contract", () => {
  test("usage errors exit 2 with a JSON error object", () => {
    const r = run(["frobnicate", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error.code).toBe("usage");
  });
  test("unknown options are rejected", () => {
    expect(run(["list", "--bogus"]).code).toBe(2);
  });
  test("out-of-range slots are usage errors", () => {
    const r = run(["show", "61", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error.code).toBe("invalid_slot");
  });
  test("missing files exit 8", () => {
    expect(run(["show", "/nope.preset", "--json"]).code).toBe(8);
  });
  test("help and discovery", () => {
    expect(run(["--help"]).stdout).toContain("ltctl");
    expect(run(["push", "--help"]).stdout).toContain("--replace");
    const cmds = JSON.parse(run(["commands", "--json"]).stdout);
    expect(cmds.commands.find((c: any) => c.name === "push").changesAmp).toBe(true);
    expect(run(["guide"]).stdout).toContain("EXIT CODES");
    expect(run(["completions", "zsh"]).stdout).toContain("compdef");
  });
});

(hasCatalog ? describe : describe.skip)("offline commands", () => {
  test("new → stdout → validate via stdin", () => {
    const made = run(["new", "Test Tone", "amp=ac30", "amp.gain=7", "delay=echo"]);
    expect(made.code).toBe(0);
    const v = run(["validate", "-", "--json"], made.stdout);
    expect(JSON.parse(v.stdout).ok).toBe(true);
    const shown = JSON.parse(run(["show", "-", "--json"], made.stdout).stdout);
    expect(shown.chain.find((n: any) => n.position === "amp").params.find((p: any) => p.id === "gain").value).toBeCloseTo(7, 3);
  });
  test("bad assignments exit 5 with a hint listing options", () => {
    const r = run(["new", "X", "amp=ac30", "amp.cabinet=marshall", "--json"]);
    expect(r.code).toBe(5);
    const e = JSON.parse(r.stdout).error;
    expect(e.code).toBe("invalid_input");
    expect(e.hint).toContain("2x12c");
  });
  test("factory presets resolve by name", () => {
    const r = JSON.parse(run(["show", "factory:surf", "--json"]).stdout);
    expect(r.name).toBe("Surf Music");
  });
  test("units --json describes parameters", () => {
    const r = JSON.parse(run(["units", "ac30", "--json"]).stdout);
    expect(r.units[0].params.find((p: any) => p.id === "cabsimType").options.length).toBeGreaterThan(20);
  });
});
