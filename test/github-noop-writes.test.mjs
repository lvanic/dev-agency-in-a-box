// Skip no-op GitHub writes (#160): the tracker-comment upsert must not PATCH when the rendered
// body matches what's already stored — identical re-writes are the per-scan common case on epics.
import test from "node:test";
import assert from "node:assert/strict";
import { trackerBodyUnchanged } from "../dist/github.js";

test("trackerBodyUnchanged: identical bodies are a no-op", () => {
  const b = "Epic progress\n- [x] done\n\n<!-- epic-tracker -->";
  assert.equal(trackerBodyUnchanged(b, b), true);
});

test("trackerBodyUnchanged: CRLF (GitHub-stored) equals LF (freshly rendered)", () => {
  const lf = "line one\nline two\n\n<!-- epic-tracker -->";
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.equal(trackerBodyUnchanged(crlf, lf), true, "line-ending diff alone is still a no-op");
});

test("trackerBodyUnchanged: a real content change is not a no-op", () => {
  const a = "- [ ] task\n\n<!-- epic-tracker -->";
  const b = "- [x] task\n\n<!-- epic-tracker -->";
  assert.equal(trackerBodyUnchanged(a, b), false);
});
