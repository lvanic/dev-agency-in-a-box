/**
 * Loads the markdown memory that bounds and guides the agents.
 * Phase 1 loads the always-on Constitution plus the git workflow playbook.
 * Later phases add on-demand playbook selection and vector retrieval.
 */
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getAgentOverride, getAgentDefault, listAgentOverridePaths } from "./store.js";

// Overridable (same env var as db/agent_overrides.ts) so tests can point both at a throwaway tmp
// dir instead of this actual checkout's memory/ files.
const projectRoot = process.env.AGENCY_MEMORY_ROOT?.trim() || join(dirname(fileURLToPath(import.meta.url)), "..");
const memoryRoot = join(projectRoot, "memory");

async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Read an agent file (by its repo-relative path under memory/), preferring, in order:
 *   1. a live dashboard/self-improvement edit stored in the DB (the "override"),
 *   2. the PRISTINE default captured in the DB the first time this path was ever overridden —
 *      once an override exists, setAgentOverride mirrors it onto disk, so the disk file itself
 *      is no longer a reliable "default" (see db/agent_overrides.ts); this is what a revert
 *      actually reverts to, without depending on that disk mirror having completed,
 *   3. the on-disk file — only reached for a path that's never been touched, where disk IS
 *      still the true default.
 * This is what makes edits (and reverts) take effect on the next agent run without a redeploy.
 */
async function readWithOverride(rel: string): Promise<string> {
  const ov = getAgentOverride(rel);
  if (ov != null) return ov;
  const pristine = getAgentDefault(rel);
  if (pristine != null) return pristine;
  return readIfExists(join(memoryRoot, rel));
}

/** The small, always-injected core: the Constitution. */
export async function loadConstitution(): Promise<string> {
  return readWithOverride("central/CONSTITUTION.md");
}

/** Load a named playbook from memory/central/playbooks. */
export async function loadPlaybook(name: string): Promise<string> {
  return readWithOverride(`central/playbooks/${name}.md`);
}

/** Load a role persona from memory/central/agents/<role>.md (the FIXED part). */
export async function loadPersona(role: string): Promise<string> {
  return readWithOverride(`central/agents/${role}.md`);
}

// ---- editable agent memory (for the dashboard editor) ----

export interface AgentFile {
  path: string; // relative under memory/, e.g. "central/agents/developer.md"
  label: string;
  // These are the FIXED, user-only parts. Self-improving knowledge now lives in the Central Vault
  // (docs/central-vault-plan.md), not per-agent "Learned" markdown docs — those were retired.
  group: "core" | "persona" | "playbook";
  edited: boolean; // has a live override (vs the on-disk default)
}

/** List the markdown that defines the agents: the FIXED parts (constitution, personas, playbooks). */
export async function listAgentFiles(): Promise<AgentFile[]> {
  const overridden = new Set(listAgentOverridePaths());
  const mk = (path: string, label: string, group: AgentFile["group"]): AgentFile => ({
    path,
    label,
    group,
    edited: overridden.has(path),
  });
  const out: AgentFile[] = [mk("central/CONSTITUTION.md", "Constitution", "core")];

  try {
    const personas = (await readdir(join(memoryRoot, "central", "agents")))
      .filter((f) => f.endsWith(".md") && !f.endsWith(".learned.md")) // skip any leftover legacy learned docs
      .sort();
    for (const f of personas) {
      out.push(mk(`central/agents/${f}`, f.replace(/\.md$/, ""), "persona"));
    }
  } catch {
    /* ignore */
  }
  try {
    const books = (await readdir(join(memoryRoot, "central", "playbooks")))
      .filter((f) => f.endsWith(".md") && f !== "_learned.md")
      .sort();
    for (const f of books) out.push(mk(`central/playbooks/${f}`, f.replace(/\.md$/, ""), "playbook"));
  } catch {
    /* ignore */
  }
  return out;
}

/** Only allow markdown files under memory/central (no path traversal). */
export function isSafeAgentPath(rel: string): boolean {
  return /^central\/[\w./-]+\.md$/.test(rel) && !rel.includes("..");
}

/** The effective content (live override if any, else the on-disk default). */
export async function readAgentFile(rel: string): Promise<string | null> {
  if (!isSafeAgentPath(rel)) return null;
  return readWithOverride(rel);
}

/** The path of an agent file inside the git repo (for committing edits). */
export function agentFileRepoPath(rel: string): string {
  return `memory/${rel}`;
}

/** Load several playbooks and concatenate them with headers. */
export async function loadPlaybooks(names: string[]): Promise<string> {
  const parts = await Promise.all(
    names.map(async (n) => {
      const body = await loadPlaybook(n);
      return body ? `\n----- playbook: ${n} -----\n${body}` : "";
    }),
  );
  return parts.join("\n");
}
