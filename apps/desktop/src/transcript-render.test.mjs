import assert from "node:assert/strict";
import test from "node:test";

import { planTranscriptReconciliation } from "./transcript-render.ts";

test("keeps every existing transcript row stable when a snapshot is unchanged", () => {
  assert.deepEqual(planTranscriptReconciliation(["1", "2", "3"], ["1", "2", "3"]), {
    insertions: [],
    removals: [],
    retained: ["1", "2", "3"],
  });
});

test("inserts only the new final instead of rebuilding saved rows", () => {
  assert.deepEqual(planTranscriptReconciliation(["1", "2"], ["1", "2", "3"]), {
    insertions: ["3"],
    removals: [],
    retained: ["1", "2"],
  });
});

test("handles the rolling visible window without touching retained rows", () => {
  assert.deepEqual(planTranscriptReconciliation(["1", "2", "3"], ["2", "3", "4"]), {
    insertions: ["4"],
    removals: ["1"],
    retained: ["2", "3"],
  });
});

test("rejects duplicate transcript keys before DOM reconciliation", () => {
  assert.throws(
    () => planTranscriptReconciliation(["1"], ["1", "1"]),
    /duplicate transcript key/,
  );
});
