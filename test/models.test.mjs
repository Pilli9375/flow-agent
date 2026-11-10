import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VIDEO_MODEL, modelGoneMessage } from "../dist/flow.js";

test("the default video model is the newest one", () => {
  assert.equal(DEFAULT_VIDEO_MODEL, "Omni 1.2 Flash");
});

test("a retired model gives a clear message listing what Flow offers, without 'Leaving' suffixes", () => {
  const msg = modelGoneMessage("Omni 1.1 Flash", ["Omni 1.2 Flash", "Veo 3.1 - Lite\nLeaving Dec 5", "  "]);
  assert.match(msg, /does not offer the model "Omni 1.1 Flash"/);
  assert.match(msg, /Omni 1.2 Flash, Veo 3\.1 - Lite\)/);
  assert.doesNotMatch(msg, /Leaving/);
});

test("the message still works when the menu could not be read", () => {
  assert.match(modelGoneMessage("Veo 3.1 - Fast", []), /none could be read/);
});
