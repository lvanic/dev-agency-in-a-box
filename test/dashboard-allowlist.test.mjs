// Every dashboard POST handler in webhook.ts must be listed in the dashboard-action
// allowlist gate. A handler missing from the gate is unreachable: the request falls
// through to the GitHub-webhook receiver, which answers 202 and drops it on the floor.
// This has now bitten three times (#219 install-toolchain, /create-repo, /epic-play|pause),
// so the invariant is checked statically here against the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "webhook.ts"), "utf8");

test("every gated dashboard POST handler is in the allowlist", () => {
  const gate = src.match(/if \(\[([^\]]+)\]\.includes\(path\)\)/);
  assert.ok(gate, "dashboard allowlist gate not found in webhook.ts");
  const allow = new Set([...gate[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const gateOffset = gate.index;

  // Handlers declared after the gate live inside its block; each must be allowlisted.
  const missing = [];
  for (const m of src.matchAll(/path === "(\/[a-z0-9-]+)"/g)) {
    if (m.index > gateOffset && !allow.has(m[1])) missing.push(m[1]);
  }
  assert.deepEqual(
    [...new Set(missing)],
    [],
    `dashboard POST handler(s) missing from the allowlist gate (requests fall through to the webhook receiver as silent 202s): ${[...new Set(missing)].join(", ")}`,
  );
});
