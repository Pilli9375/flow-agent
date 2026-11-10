import { test } from "node:test";
import assert from "node:assert/strict";
import { _guard } from "../dist/library.js";

// The library may only move items to the Trash and restore them: anything that deletes for good must be refused.
test("every delete-style control is blocked", () => {
  for (const name of ["Delete permanently", "Delete all", "Delete project", "Delete", "delete forever", "Empty trash", "Restore all", "Remove all", "Erase", "Permanently remove"]) {
    assert.throws(() => _guard(name), /Refusing to click/, name);
  }
});

test("the safe controls are allowed", () => {
  for (const name of ["Move to trash", "Restore", "Rename", "Set project cover", "More options", "Favorite", "Remove favorite"]) {
    assert.doesNotThrow(() => _guard(name), name);
  }
});
