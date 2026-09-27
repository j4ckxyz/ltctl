// AmpClient.readPresets ordering/concurrency, against a fake request layer.
import { expect, test } from "bun:test";
import { AmpClient } from "../src/amp";
import { Preset } from "../src/preset";

const EMPTY = (slot: number) =>
  `{"nodeType":"preset","info":{"displayName":"EMPTY           "},"audioGraph":{"nodes":[],"connections":[]}}`.replace("EMPTY", slot === 3 ? "THREE" : "EMPTY");

function fakeClient(): AmpClient {
  const amp = new AmpClient();
  // Replies arrive out of order to exercise in-order emission.
  (amp as any).fetchPreset = async (slot: number) => {
    await Bun.sleep(slot % 2 ? 5 : 1);
    return Preset.parse(EMPTY(slot), slot);
  };
  return amp;
}

test("readPresets without a callback returns every slot in order", async () => {
  const presets = await fakeClient().readPresets([1, 2, 3, 4, 5]);
  expect(presets.map((p) => p.slot)).toEqual([1, 2, 3, 4, 5]);
});

test("readPresets emits in slot order", async () => {
  const seen: number[] = [];
  await fakeClient().readPresets([5, 1, 3, 2], (p) => seen.push(p.slot!));
  expect(seen).toEqual([5, 1, 3, 2]);
});
