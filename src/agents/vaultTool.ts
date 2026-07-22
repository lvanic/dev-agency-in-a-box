/**
 * `vault_prose` — the Central Vault's translate tool exposed to a running agent (Phase 2). Agents
 * already get the compact canonical vault slice injected into their system prompt (roleAgent.ts); this
 * tool is the "translate when prose is genuinely needed" escape hatch: it returns the SAME applicable
 * entries (global + this repo's scope + this role) rendered as human-readable markdown via renderVault,
 * deterministically (no model call). In-process MCP server, same shape as recallWiring.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { listVault, scopeMatches } from "../store.js";
import { renderVault } from "../vaultTranslate.js";

export interface VaultToolWiring {
  servers: Record<string, ReturnType<typeof createSdkMcpServer>>;
  tools: string[];
}

/** Build the in-process `vault_prose` server scoped to a repo + role. */
export function vaultToolWiring(repo: string, role: string): VaultToolWiring {
  const server = createSdkMcpServer({
    name: "vault",
    version: "1.0.0",
    tools: [
      tool(
        "vault_prose",
        "Render the durable shared knowledge that applies to you (the Central Vault — user preferences, environment facts, cross-project craft knowledge) as readable prose. You already see the compact one-line records in your system prompt; call this only when you want the same facts spelled out in plain English.",
        {},
        async () => {
          const entries = listVault({ role })
            .filter((r) => scopeMatches(r.entry.s, repo))
            .map((r) => r.entry);
          const md = renderVault(entries);
          return { content: [{ type: "text" as const, text: md }] };
        },
      ),
    ],
  });
  return { servers: { vault: server }, tools: ["mcp__vault__vault_prose"] };
}
