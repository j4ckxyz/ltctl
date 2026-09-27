import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Catalog, parseTaper, taperCalc, taperInvert } from "../src/catalog";
import { PresetEditor } from "../src/editor";
import { ampName, displayName, minifyJSON, Preset } from "../src/preset";
import { diff, specAssignments, summarize } from "../src/summary";

const catalogPath = join(import.meta.dir, "../../build/catalog.json");
const catalog = existsSync(catalogPath) ? new Catalog(await Bun.file(catalogPath).json(), catalogPath) : undefined;
const withCatalog = catalog ? describe : describe.skip;

describe("tapers", () => {
  test("t10 is 10% at half travel, t10r 90%", () => {
    expect(taperCalc(parseTaper("t10"), 0.5)).toBeCloseTo(0.1, 6);
    expect(taperCalc(parseTaper("t10r"), 0.5)).toBeCloseTo(0.9, 3);
    expect(parseTaper("t50")).toEqual({ kind: "linear" });
  });
  test.each(["t10", "t10i", "t10r", "t10ri", "t15", "t20r", "t20ri", "t30", "t30i", "t30s", "t20rs", "t45rsi"])("%s inverts", (name) => {
    const t = parseTaper(name);
    for (let x = 0; x <= 1; x += 0.125) expect(taperInvert(t, taperCalc(t, x))).toBeCloseTo(x, 6);
  });
});

describe("names", () => {
  test("display names", () => {
    expect(displayName("JAZZ       AMP  ")).toBe("Jazz Amp");
    expect(displayName("KEEP UR SELF ALI")).toBe("Keep Ur Self Ali");
  });
  test("amp names fit two lines of 8", () => {
    expect(ampName("Spread Wings")).toBe("SPREAD  WINGS   ");
    expect(ampName("Queen")).toBe("QUEEN           ");
    expect(ampName("Warm Lead")).toBe("WARM    LEAD    ");
    expect(ampName("Track 182")).toBe("TRACK   182     ");
    expect(ampName("keep ur self ali")).toBe("KEEP UR SELF ALI");
    expect(ampName("ACOUSTICSIM")).toBe("ACOUSTICSIM     ");
    expect(() => ampName("Spread Your Wings")).toThrow(/doesn't fit/);
    expect(() => ampName("Rock & Roll")).toThrow(/can't show/);
  });
  test("minify keeps strings intact", () => {
    expect(minifyJSON('{ "a b" : [1, 2],\n "c": "x \\" y" }')).toBe('{"a b":[1,2],"c":"x \\" y"}');
  });
});

const EMPTY = `{"nodeType":"preset","info":{"displayName":"EMPTY           ","product_id":"mustang-lt"},"audioGraph":{"nodes":[
{"nodeId":"stomp","FenderId":"DUBS_Passthru","dspUnitParameters":{"bypass":false}},
{"nodeId":"mod","FenderId":"DUBS_Passthru","dspUnitParameters":{}},
{"nodeId":"amp","FenderId":"DUBS_Twin65","dspUnitParameters":{"volume":-4.497767,"bright":true,"cabsimType":"65twn"}},
{"nodeId":"delay","FenderId":"DUBS_Passthru","dspUnitParameters":{}},
{"nodeId":"reverb","FenderId":"DUBS_Passthru","dspUnitParameters":{}}],"connections":[]}}`;

describe("presets", () => {
  const p = Preset.parse(EMPTY, 49);
  test("parses", () => {
    expect(p.isEmptySlot).toBe(true);
    expect(p.node("amp")?.params.bright).toBe(true);
    expect(p.validate(undefined)).toEqual([]);
    expect(p.fileBaseName).toBe("49 Empty");
  });
  test("rejects non-presets and missing nodes", () => {
    expect(() => Preset.parse('{"nodeType":"dspUnit"}', undefined)).toThrow();
    expect(Preset.parse(EMPTY.replace('"nodeId":"reverb"', '"nodeId":"other"'), undefined).validate(undefined).length).toBeGreaterThan(0);
  });
  test("flags bypass: true, which the amp never stores", () => {
    const bypassed = EMPTY.replace('"FenderId":"DUBS_Passthru","dspUnitParameters":{"bypass":false}', '"FenderId":"DUBS_Overdrive","dspUnitParameters":{"bypass":true}');
    expect(Preset.parse(bypassed, undefined).validate(undefined).join()).toContain("bypass");
  });
  test("content comparison ignores formatting and key order", () => {
    expect(Preset.parse(EMPTY, 1).sameContent(Preset.parse(JSON.stringify(JSON.parse(EMPTY), null, 3), 1))).toBe(true);
  });
});

withCatalog("catalog", () => {
  const c = catalog!;
  test("LT offers 20 amps and 100 factory presets", () => {
    expect(c.options.get("amp")?.length).toBe(20);
    expect(c.options.get("stomp")?.[0]?.fenderId).toBe("DUBS_Passthru");
    expect(c.factoryPresets.length).toBe(100);
  });
  test("knob conversions match Fender Tone", () => {
    const volume = c.unit("DUBS_Twin65")!.param("volume")!;
    expect(volume.display(-4.497767)).toBe("8.0");
    expect(volume.rawValue(1)).toBeCloseTo(-60, 6);
    expect(volume.rawValue(10)).toBeCloseTo(0, 6);
    expect(volume.displayValue(volume.rawValue(6.5)!)).toBeCloseTo(6.5, 9);
    expect(c.unit("DUBS_MonoDelay")!.param("time")!.display(0.4)).toBe("400 ms");
    expect(c.unit("DUBS_Ac30Tb")!.param("bias")!.display(0.5)).toBe("+0.0 %");
    const cab = c.unit("DUBS_Twin65")!.param("cabsimType")!;
    expect([cab.onPanel, cab.display("65twn")]).toEqual([false, "'65 Twin"]);
  });
});

withCatalog("editor", () => {
  const c = catalog!;
  const make = (...a: string[]) => {
    const e = new PresetEditor(c);
    a.forEach((x) => e.apply(x));
    return e.preset();
  };
  test("builds a preset from display values", () => {
    const p = make("name=Spread Wings", "amp=ac30", "amp.gain=6", "amp.treble=5.8", "amp.cabinet=2x12 blue", "amp.bright=off",
      "stomp=overdrive", "stomp.gain=2.5", "delay=delay", "delay.time=800ms", "reverb=small room");
    expect(p.rawName).toBe("SPREAD  WINGS   ");
    expect(p.validate(c)).toEqual([]);
    const amp = p.node("amp")!;
    expect(amp.fenderId).toBe("DUBS_Ac30Tb");
    expect(amp.params.gain).toBeCloseTo(5 / 9, 6);
    expect(amp.params.cabsimType).toBe("2x12c");
    expect(amp.params.bright).toBe(false);
    expect(p.node("stomp")!.params.gain).toBeCloseTo(0.339368, 5); // t30r taper
    expect(p.node("delay")!.params.time).toBeCloseTo(0.8, 6);
    expect(p.node("reverb")!.params.bypassType).toBe("Pre");
  });
  test("accepts seconds, raw values and menu names", () => {
    const p = make("name=X", "amp=60S UK CLN", "delay=echo", "delay.time=0.25s", "amp.volume=raw:-3");
    expect(p.node("delay")!.params.dlyTime).toBeCloseTo(0.25, 6);
    expect(p.node("amp")!.params.volume).toBe(-3);
  });
  test("none empties a position but not the amp", () => {
    expect(make("name=X", "delay=delay", "delay=none").node("delay")!.fenderId).toBe("DUBS_Passthru");
    expect(() => make("amp=none")).toThrow(/can't be empty/);
  });
  test("helpful errors", () => {
    expect(() => make("amp=ac30", "amp.gain=11")).toThrow(/out of range/);
    expect(() => make("amp=ac30", "amp.cabinet=marshall")).toThrow(/can't be/);
    expect(() => make("amp=twin")).toThrow(/several/);
    expect(() => make("stomp=ac30")).toThrow(/no stomp unit/);
    expect(() => make("amp=ac30", "amp.wobble=1")).toThrow(/no parameter/);
    expect(() => make("reverb.level=3")).toThrow(/empty/);
    expect(() => make("amp=ac30", "amp.gate=off")).toThrow(/several/);
    expect(make("name=X", "amp=ac30", "amp.cab=2x12 blue", "amp.noisegate=low").node("amp")!.params.gatePreset).toBe("low");
  });
  test("tone spec and diff", () => {
    const p = make(...specAssignments(JSON.stringify({ name: "Spec", amp: { unit: "ac30", gain: 7 }, delay: null })));
    expect(p.node("amp")!.params.gain).toBeCloseTo(6 / 9, 6);
    const q = make(...specAssignments(JSON.stringify(summarize(p, c))));
    expect(diff(summarize(p, c), summarize(q, c))).toEqual([]);
    expect(diff(summarize(p, c), summarize(make("name=Spec", "amp=ac30", "amp.gain=8"), c)).map((x) => x.key)).toEqual(["amp.gain"]);
  });
});
