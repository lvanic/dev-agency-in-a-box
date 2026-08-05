// The system prompt's SHARED block (output style + constitution) must come before any
// role-specific material. Anthropic's prompt cache matches on an exact prefix, so a single
// role-specific byte near the top forks the prefix and every agent after the first pays a full
// cache WRITE instead of a cheap cache READ. Before this ordering, the persona sat at position 2
// and all 4 roles of a run re-wrote the constitution/playbook block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../dist/agents/roleAgent.js";

/** Length of the identical leading substring of two strings. */
function sharedPrefixLen(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

test("different roles share the constitution block as an identical prompt prefix", async () => {
  const planner = await buildSystemPrompt("planner");
  const developer = await buildSystemPrompt("developer");
  const reviewer = await buildSystemPrompt("reviewer");

  const shared = planner.slice(0, sharedPrefixLen(planner, developer));

  // The shared prefix must actually carry the two big static blocks — that is the whole point.
  assert.ok(shared.includes("=== OUTPUT STYLE (strict) ==="), "output style must be inside the shared prefix");
  assert.ok(shared.includes("=== CONSTITUTION (hard rules — always obey) ==="), "constitution header must be inside the shared prefix");
  assert.ok(shared.length > 2000, `shared prefix too short (${shared.length} chars) — role-specific text has crept above the constitution`);

  // Every role pair must share it, not just this one.
  assert.equal(sharedPrefixLen(planner, reviewer) >= shared.length, true, "planner/reviewer share less prefix than planner/developer");
  assert.equal(sharedPrefixLen(developer, reviewer) >= shared.length, true, "developer/reviewer share less prefix than planner/developer");

  // ...and the roles must still differ AFTER it (each keeps its own persona/playbooks).
  assert.notEqual(planner, developer, "roles must still get different prompts below the shared block");
  assert.ok(planner.includes("=== YOUR ROLE ==="), "role block header missing");
});
