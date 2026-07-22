// Tests for the agent-editor override/default/revert loop (P4.10). Redirects BOTH the SQLite
// file (DB_PATH) and the memory/ disk mirror (AGENCY_MEMORY_ROOT) at a throwaway tmp dir so this
// never touches the real checkout's memory/ files.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const memRoot = mkdtempSync(join(tmpdir(), "agentoverrides-mem-"));
process.env.AGENCY_MEMORY_ROOT = memRoot;
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "agentoverrides-db-")), "agency.db");

const { getDb } = await import("../dist/db/connection.js");
getDb();
const { setAgentOverride, getAgentOverride, getAgentDefault, deleteAgentOverride } = await import("../dist/db/agent_overrides.js");
const { readAgentFile } = await import("../dist/memory.js");

const PATH = "central/playbooks/_test_pristine.md";
const ABS = join(memRoot, "memory", "central", "playbooks", "_test_pristine.md");

test("setAgentOverride captures the pristine on-disk default before its first mirror, and revert restores it (not the last edit)", async () => {
  mkdirSync(join(memRoot, "memory", "central", "playbooks"), { recursive: true });
  writeFileSync(ABS, "PRISTINE DEFAULT CONTENT");

  // Never touched yet → no pristine snapshot captured.
  assert.equal(getAgentDefault(PATH), null);

  // First edit: the override applies immediately, and the pristine snapshot is captured from
  // whatever was on disk BEFORE this edit's mirror can overwrite it.
  setAgentOverride(PATH, "EDIT 1", "test");
  assert.equal(getAgentOverride(PATH), "EDIT 1");
  assert.equal(getAgentDefault(PATH), "PRISTINE DEFAULT CONTENT");
  assert.equal(await readAgentFile(PATH), "EDIT 1", "effective content is the live override");

  // A second edit must NOT re-capture the snapshot (it would otherwise capture the mirrored
  // first edit instead of the true original default).
  setAgentOverride(PATH, "EDIT 2", "test");
  assert.equal(getAgentDefault(PATH), "PRISTINE DEFAULT CONTENT", "pristine snapshot is captured once, not re-taken");

  // Revert: drops the override. The effective content must fall back to the PRISTINE snapshot,
  // never to "EDIT 2" (which is what a disk-mirror-based fallback would have returned once the
  // on-disk file itself had become the last edit).
  deleteAgentOverride(PATH);
  assert.equal(getAgentOverride(PATH), null);
  assert.equal(await readAgentFile(PATH), "PRISTINE DEFAULT CONTENT", "revert returns the true pristine default, not the last edit");
});

test("a path that's never been overridden has no pristine snapshot and reads straight from disk", async () => {
  const untouched = "central/playbooks/_test_untouched.md";
  const abs = join(memRoot, "memory", "central", "playbooks", "_test_untouched.md");
  mkdirSync(join(memRoot, "memory", "central", "playbooks"), { recursive: true });
  writeFileSync(abs, "UNTOUCHED ON-DISK CONTENT");

  assert.equal(getAgentDefault(untouched), null);
  assert.equal(await readAgentFile(untouched), "UNTOUCHED ON-DISK CONTENT");
});
