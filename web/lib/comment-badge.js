// Comment role-badge helpers — pure functions, no component deps. Read the author role of an
// agency comment from its leading badge line ("🧠 **Planner**", "🤖 **Name** · _dev-agency_", …)
// and strip that redundant line once the role badge is shown in the comment header instead.
// Moved out of core.js (P6 cleanup); role words/emoji are the shared persona data in data/logos.js.

import { ROLE_WORDS, ROLE_EMOJI } from "../data/logos.js";

// The author role of an agency comment, read from its leading badge.
export function roleFromComment(body) {
  const raw = (body || "").slice(0, 90);
  const head = raw.toLowerCase();
  for (const r of ROLE_WORDS) if (head.includes(r)) return r;
  // Custom workflow agent badge: "🤖 **Name** · _dev-agency_" → its name (resolves to a pooled face).
  const m = raw.match(/^\s*🤖\s*\*\*([^*]+)\*\*/);
  return m ? m[1].trim().toLowerCase() : null;
}

// Role badge for an agency comment, rendered inline in the comment header (emoji · Role) so the
// redundant "💻 **Developer** · _dev-agency_" first body line can be stripped (see stripBadge).
export function commentBadge(body) {
  const r = roleFromComment(body);
  if (!r) return null;
  const emoji = ROLE_EMOJI[r] || "🤖";
  return { role: r, emoji, name: r[0].toUpperCase() + r.slice(1) };
}

// Drop the leading "🧠 **Planner** · _dev-agency_" line (now shown in the header) from a comment body.
export function stripBadge(body) {
  return (body || "").replace(/^\s*[^\n]*·\s*_dev-agency_\s*\r?\n+/, "");
}
