import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demangle, extractCatalog } from "../src/extract";

test("demangles the Itanium names the catalogue uses", () => {
  expect(demangle("__ZN4fmic4dubs2lt7mustang18DUBS_Twin65DefaultE")).toBe("fmic::dubs::lt::mustang::DUBS_Twin65Default");
  expect(demangle("__ZN4fmic2pp2lt12PP_MustangLTE")).toBe("fmic::pp::lt::PP_MustangLT");
  expect(demangle("__ZN4fmicL7presetsE")).toBe("fmic::presets");
  expect(demangle("_main")).toBeUndefined();
});

const app = "/Applications/Fender Tone LT Desktop.app";
const reference = join(import.meta.dir, "../../build/catalog.json");
(existsSync(app) && existsSync(reference) ? describe : describe.skip)("with Fender Tone LT Desktop installed", () => {
  test("extraction matches the reference catalogue", () => {
    expect(extractCatalog(app)).toEqual(JSON.parse(readFileSync(reference, "utf8")));
  });
});

(existsSync(reference) ? describe : describe.skip)("setup", () => {
  test("installs a catalog.json and doctor finds it", () => {
    const home = mkdtempSync(join(tmpdir(), "ltctl-home-"));
    const env = { ...process.env, TONELT_HOME: home, NO_COLOR: "1", TONELT_CATALOG: "" };
    const main = join(import.meta.dir, "../src/main.ts");
    const setup = Bun.spawnSync(["bun", main, "setup", reference, "--json"], { env });
    expect(setup.exitCode).toBe(0);
    expect(JSON.parse(setup.stdout.toString()).units).toBe(54);
    expect(existsSync(join(home, "catalog.json"))).toBe(true);
    const doctor = JSON.parse(Bun.spawnSync(["bun", main, "doctor", "--json"], { env }).stdout.toString());
    expect(doctor.catalog.path).toBe(join(home, "catalog.json"));
  });
});
