/**
 * Price-annotated model catalog (P3, prime-time-plan). There is still NO static model catalog
 * (src/db/providers.ts discovers a provider's real models live via `pi --list-models`); this only
 * annotates whichever model ids show up with a $/Mtok in+out price and a capability tier, so
 * selection can pick "cheapest capable" instead of a hardcoded per-role model.
 *
 * Two layers, DB-backed override wins:
 *   1. A static SEED table (substring match on the model id — provider-returned ids commonly carry
 *      a date/version suffix, e.g. "claude-haiku-4-5-20251001").
 *   2. Per-model overrides edited in Settings → Models, persisted the same JSON-blob-in-settings way
 *      every other provider/model setting is (see db/providers.ts) — `getSetting`/`setSetting`.
 */
import { getSetting, setSetting } from "../db/settings.js";
import { getProviders, tierModel, type Tier } from "../db/providers.js";
import { canonicalModel } from "./roles.js";

export interface Price {
  in: number; // $ / Mtok input
  out: number; // $ / Mtok output
}

interface SeedEntry {
  /** Substring matched against the (canonicalized, lowercased) model id. */
  match: string;
  /** Capability class this model belongs to — used to keep "cheapest" swaps same-capability. */
  tier: Tier;
  in: number;
  out: number;
}

// Researched 2026-07-22, $/Mtok in/out. Longest/most-specific `match` wins when several substrings
// hit the same id (see seedFor). Third-party ids (glm/deepseek/kimi/...) are priced + tiered here
// too — they're what makes "cheapest capable" meaningfully different from the sonnet/opus default.
const SEED: SeedEntry[] = [
  { match: "claude-fable-5", tier: "high", in: 10, out: 50 },
  { match: "claude-opus-4-8", tier: "high", in: 5, out: 25 },
  { match: "claude-opus-4-7", tier: "high", in: 5, out: 25 },
  { match: "claude-opus-4-6", tier: "high", in: 5, out: 25 },
  { match: "claude-sonnet-5", tier: "medium", in: 3, out: 15 },
  { match: "claude-sonnet-4-6", tier: "medium", in: 3, out: 15 },
  { match: "claude-haiku-4-5", tier: "low", in: 1, out: 5 },
  { match: "glm-4.6", tier: "medium", in: 0.43, out: 1.75 },
  { match: "deepseek-chat", tier: "medium", in: 0.23, out: 0.34 },
  { match: "deepseek-v3.2", tier: "medium", in: 0.23, out: 0.34 },
  { match: "deepseek", tier: "medium", in: 0.23, out: 0.34 }, // generic fallback for other v3.2-family ids
  { match: "kimi-k2.5", tier: "medium", in: 0.44, out: 2.0 },
  { match: "kimi-k2.6", tier: "medium", in: 0.75, out: 3.5 },
  { match: "kimi-k2-0905", tier: "medium", in: 0.6, out: 2.5 },
];

function seedFor(modelId: string): SeedEntry | null {
  const id = canonicalModel((modelId || "").trim()).toLowerCase();
  if (!id) return null;
  let best: SeedEntry | null = null;
  for (const e of SEED) {
    if (id.includes(e.match) && (!best || e.match.length > best.match.length)) best = e;
  }
  return best;
}

/** The capability tier a KNOWN model belongs to, or null when the id matches no seed entry (an
 *  unclassified/unknown model — still a legal tier candidate, see cheapestInTier). */
export function tierFor(modelId: string): Tier | null {
  return seedFor(modelId)?.tier ?? null;
}

const OVERRIDE_KEY = "model_price_overrides";

/** Per-model $/Mtok overrides edited in Settings → Models. Keyed by the exact model id string. */
export function getPriceOverrides(): Record<string, Price> {
  try {
    return JSON.parse(getSetting(OVERRIDE_KEY) ?? "{}") as Record<string, Price>;
  } catch {
    return {};
  }
}
/** True for a well-formed, non-negative $/Mtok price pair — the single validation both the
 *  Settings → Models POST handler (webhook.ts) and setPriceOverride() use, so a malformed or
 *  negative payload is rejected consistently everywhere a price gets written. */
export function isValidPrice(v: unknown): v is Price {
  if (!v || typeof v !== "object") return false;
  const p = v as { in?: unknown; out?: unknown };
  return Number.isFinite(p.in) && Number(p.in) >= 0 && Number.isFinite(p.out) && Number(p.out) >= 0;
}

/** `price: null` clears an existing override (explicit clear); a valid {in,out} sets one. Any OTHER
 *  (malformed/negative/non-finite) non-null value is a no-op — the existing override, if any, is left
 *  untouched. Malformed input must never be silently treated as a clear (the webhook handler already
 *  rejects it with 400 before calling this, but this is the safety net for every other caller too). */
export function setPriceOverride(modelId: string, price: Price | null): void {
  const id = (modelId || "").trim();
  if (!id) return;
  const cur = getPriceOverrides();
  if (price === null) {
    delete cur[id];
  } else if (isValidPrice(price)) {
    cur[id] = { in: price.in, out: price.out };
  } else {
    return; // malformed — leave the existing override (and settings row) untouched
  }
  setSetting(OVERRIDE_KEY, JSON.stringify(cur));
}

/** Resolved $/Mtok price for a model id: DB override first, else the static seed, else null (truly
 *  unknown — no price data anywhere). */
export function priceFor(modelId: string): Price | null {
  const id = (modelId || "").trim();
  if (!id) return null;
  const overrides = getPriceOverrides();
  const overrideKey = Object.keys(overrides).find((k) => k.toLowerCase() === id.toLowerCase());
  if (overrideKey) return overrides[overrideKey];
  const seed = seedFor(id);
  return seed ? { in: seed.in, out: seed.out } : null;
}

/**
 * Cheapest capable model in `tier` among `models` (a provider's discovered/active catalogue).
 * Candidates = models classified into `tier`, PLUS unclassified models (no seed match — we don't
 * know their capability, so we don't exclude them, but we never let an unpriced/unclassified model
 * win over a KNOWN, priced same-tier one). Models known to belong to a DIFFERENT tier are excluded
 * — cost never downgrades capability. Ranked by output price asc, tie-break input price asc, then
 * input order; unknown price ranks last (stable amongst themselves).
 */
export function cheapestInTier(models: string[], tier: Tier): string | null {
  const raw = (models || []).filter((m) => {
    const t = tierFor(m);
    return t === null || t === tier; // exclude models classified into a DIFFERENT tier
  });
  if (!raw.length) return null;
  // A model's PRICE can be overridden without a TIER classification (setPriceOverride carries no
  // tier), so an unclassified model can otherwise pick up an (e.g. deliberately low) override price
  // and win purely on numbers with zero capability evidence. Once at least one classified, PRICED
  // same-tier candidate exists, unclassified models are excluded outright — never let them win over
  // a classified candidate. Only fall back to considering them when NO classified+priced candidate
  // exists at all (nothing to safely compare against).
  const hasClassifiedPriced = raw.some((m) => tierFor(m) === tier && priceFor(m) != null);
  const pool = hasClassifiedPriced ? raw.filter((m) => tierFor(m) === tier) : raw;
  const ranked = pool.map((m, i) => ({ m, i, p: priceFor(m) }));
  ranked.sort((a, b) => {
    if (a.p && b.p) {
      if (a.p.out !== b.p.out) return a.p.out - b.p.out;
      if (a.p.in !== b.p.in) return a.p.in - b.p.in;
      return a.i - b.i;
    }
    if (a.p && !b.p) return -1;
    if (!a.p && b.p) return 1;
    return a.i - b.i;
  });
  return ranked[0].m;
}

export interface TierPick {
  providerId: string;
  model: string;
  /** true when a priced, same-tier candidate was actually found and substituted for the provider's
   *  pinned tier-slot model (false → fell back to the existing tierModel() default). */
  costAware: boolean;
  price: Price | null;
}

/**
 * Cost-aware tier resolution for a provider: pick the cheapest capable model in `tier` from its
 * active catalogue; fall back to the existing pinned tier-slot model (or first model) when no
 * known-tier candidate is found — this NEVER returns null where the old tierModel() wouldn't have.
 */
export function resolveTierModel(providerId: string, tier: Tier): TierPick | null {
  const p = getProviders().find((x) => x.id === providerId);
  if (!p) return null;
  const pool = p.activeModels && p.activeModels.length ? p.activeModels : p.models;
  const cheapest = cheapestInTier(pool || [], tier);
  const cheapestPrice = cheapest ? priceFor(cheapest) : null;
  // Only call it "cost-aware" when the pick is actually backed by price data — with NO priced
  // candidate in the tier at all we have no cost signal to act on, so defer to the existing default
  // (the provider's pinned tier-slot model, or its first model) rather than an arbitrary pick.
  if (cheapest && cheapestPrice) return { providerId, model: cheapest, costAware: true, price: cheapestPrice };
  const fb = tierModel(providerId, tier);
  return fb ? { providerId: fb.providerId, model: fb.model, costAware: false, price: priceFor(fb.model) } : null;
}

/** All known (model id → price) pairs across a set of provider catalogs, seed + overrides merged —
 *  for the Settings → Models price column ("known" = seed OR an explicit override; anything else
 *  shows as unpriced/editable). */
export function pricesForModels(modelIds: string[]): Record<string, Price | null> {
  const out: Record<string, Price | null> = {};
  for (const id of new Set(modelIds)) out[id] = priceFor(id);
  return out;
}
