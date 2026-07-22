// P3 (prime-time-plan): price seed + DB override precedence, and cheapest-in-tier selection.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "pricing-")), "agency.db");
const { priceFor, tierFor, cheapestInTier, getPriceOverrides, setPriceOverride, resolveTierModel, isValidPrice } = await import(
  "../dist/agents/pricing.js"
);
const { setProviders } = await import("../dist/db/providers.js");

test("priceFor: known seed ids resolve by substring, including dated Claude ids", () => {
  assert.deepEqual(priceFor("claude-haiku-4-5-20251001"), { in: 1, out: 5 });
  assert.deepEqual(priceFor("claude-sonnet-4-6"), { in: 3, out: 15 });
  assert.deepEqual(priceFor("claude-opus-4-8-20260101"), { in: 5, out: 25 });
  assert.deepEqual(priceFor("claude-fable-5"), { in: 10, out: 50 });
  assert.deepEqual(priceFor("glm-4.6"), { in: 0.43, out: 1.75 });
  assert.deepEqual(priceFor("deepseek-chat"), { in: 0.23, out: 0.34 });
  assert.deepEqual(priceFor("kimi-k2.6"), { in: 0.75, out: 3.5 });
});

test("priceFor: a truly unknown model id → null", () => {
  assert.equal(priceFor("some-random-model-9000"), null);
});

test("tierFor: classifies known ids into high/medium/low; unknown → null", () => {
  assert.equal(tierFor("claude-opus-4-8"), "high");
  assert.equal(tierFor("claude-sonnet-4-6"), "medium");
  assert.equal(tierFor("claude-haiku-4-5"), "low");
  assert.equal(tierFor("glm-4.6"), "medium");
  assert.equal(tierFor("nonexistent-model"), null);
});

test("DB override wins over the seed, and can be cleared back to the seed", () => {
  assert.deepEqual(priceFor("claude-sonnet-4-6"), { in: 3, out: 15 });
  setPriceOverride("claude-sonnet-4-6", { in: 1, out: 2 });
  assert.deepEqual(priceFor("claude-sonnet-4-6"), { in: 1, out: 2 });
  assert.deepEqual(getPriceOverrides()["claude-sonnet-4-6"], { in: 1, out: 2 });
  setPriceOverride("claude-sonnet-4-6", null);
  assert.deepEqual(priceFor("claude-sonnet-4-6"), { in: 3, out: 15 }, "clearing the override reverts to the seed");
});

test("DB override on a wholly unknown model id gives it a price where there was none", () => {
  assert.equal(priceFor("my-custom-model"), null);
  setPriceOverride("my-custom-model", { in: 0.1, out: 0.2 });
  assert.deepEqual(priceFor("my-custom-model"), { in: 0.1, out: 0.2 });
  setPriceOverride("my-custom-model", null);
});

test("cheapestInTier: picks the lowest output price within the same capability tier", () => {
  const models = ["claude-sonnet-4-6", "glm-4.6", "kimi-k2.6", "claude-haiku-4-5"];
  // haiku is a different (low) tier — excluded even though it's the cheapest overall.
  assert.equal(cheapestInTier(models, "medium"), "glm-4.6"); // $1.75/M out beats sonnet's $15 and kimi's $3.50
  assert.equal(cheapestInTier(models, "low"), "claude-haiku-4-5");
  assert.equal(cheapestInTier(models, "high"), null); // no high-tier model in the pool
});

test("cheapestInTier: ties break on input price, then keep input order", () => {
  setPriceOverride("model-a", { in: 2, out: 1 });
  setPriceOverride("model-b", { in: 1, out: 1 });
  assert.equal(cheapestInTier(["model-a", "model-b"], "medium"), "model-b");
  setPriceOverride("model-a", null);
  setPriceOverride("model-b", null);
});

test("cheapestInTier: unpriced/unclassified models are eligible but rank last", () => {
  const models = ["totally-unknown-model", "glm-4.6"];
  assert.equal(cheapestInTier(models, "medium"), "glm-4.6");
  // with no known-tier candidate at all, the unknown one is still returned (never null when the pool
  // isn't empty and nothing is excluded outright)
  assert.equal(cheapestInTier(["totally-unknown-model"], "medium"), "totally-unknown-model");
});

test("cheapestInTier: an unclassified model can't win over a classified same-tier model just by having a cheaper (e.g. overridden) price", () => {
  // "cheap-mystery" has NO seed tier — an override price alone must never let it beat a model we
  // actually know is capable at this tier, even though its override price is far lower.
  setPriceOverride("cheap-mystery", { in: 0.01, out: 0.01 });
  assert.equal(tierFor("cheap-mystery"), null, "still unclassified — an override carries no tier");
  const models = ["cheap-mystery", "claude-sonnet-4-6"]; // sonnet: classified medium, priced $15/M out
  assert.equal(cheapestInTier(models, "medium"), "claude-sonnet-4-6", "classified+priced beats unclassified regardless of price");
  // Without ANY classified+priced candidate in the pool, the unclassified one is still eligible
  // (matches the "unless the tier has zero classified priced candidates" carve-out).
  assert.equal(cheapestInTier(["cheap-mystery"], "medium"), "cheap-mystery");
  setPriceOverride("cheap-mystery", null);
});

test("resolveTierModel: substitutes the cheapest priced model for the provider's pinned tier slot", () => {
  setProviders([
    {
      id: "glm", name: "GLM", baseUrl: "https://x", apiKey: "k",
      models: ["glm-4.6", "glm-4.5-air"],
      tiers: { medium: { model: "glm-4.5-air" } }, // admin pinned a DIFFERENT (unpriced) model
    },
  ]);
  const pick = resolveTierModel("glm", "medium");
  assert.equal(pick.model, "glm-4.6", "cheaper priced glm-4.6 wins over the pinned, unpriced slot model");
  assert.equal(pick.costAware, true);
  assert.deepEqual(pick.price, { in: 0.43, out: 1.75 });
});

test("isValidPrice: finite, non-negative {in,out} only — rejects negatives, non-numbers, and shapeless input", () => {
  assert.equal(isValidPrice({ in: 1, out: 2 }), true);
  assert.equal(isValidPrice({ in: 0, out: 0 }), true, "zero is a valid (free) price");
  assert.equal(isValidPrice({ in: -1, out: 2 }), false, "negative in");
  assert.equal(isValidPrice({ in: 1, out: -2 }), false, "negative out");
  assert.equal(isValidPrice({ in: NaN, out: 2 }), false);
  assert.equal(isValidPrice({ in: Infinity, out: 2 }), false);
  assert.equal(isValidPrice({ in: "1", out: "2" }), false, "strings are not numbers, even if numeric-looking");
  assert.equal(isValidPrice({ in: 1 }), false, "missing out");
  assert.equal(isValidPrice(null), false);
  assert.equal(isValidPrice("1/2"), false);
  assert.equal(isValidPrice(5), false);
});

test("setPriceOverride: a malformed (non-null) price is a no-op — leaves any existing override untouched", () => {
  setPriceOverride("guarded-model", { in: 1, out: 2 });
  assert.deepEqual(priceFor("guarded-model"), { in: 1, out: 2 });
  setPriceOverride("guarded-model", { in: -5, out: 10 }); // malformed: negative
  assert.deepEqual(priceFor("guarded-model"), { in: 1, out: 2 }, "negative price never overwrites the existing override");
  setPriceOverride("guarded-model", { in: "x", out: "y" }); // malformed: not numbers
  assert.deepEqual(priceFor("guarded-model"), { in: 1, out: 2 }, "non-numeric price never overwrites the existing override");
  setPriceOverride("guarded-model", null); // the only way to actually clear it
  assert.equal(priceFor("guarded-model"), null);
});

test("setPriceOverride: a malformed price on a model with NO existing override still sets nothing", () => {
  assert.equal(priceFor("never-set-model"), null);
  setPriceOverride("never-set-model", { in: -1, out: -1 });
  assert.equal(priceFor("never-set-model"), null, "malformed input creates no override where none existed");
});

test("resolveTierModel: falls back to the existing pinned tier model when nothing is priced", () => {
  setProviders([
    {
      id: "mystery", name: "Mystery", baseUrl: "https://x", apiKey: "k",
      models: ["mystery-a", "mystery-b"],
      tiers: { medium: { model: "mystery-b" } },
    },
  ]);
  const pick = resolveTierModel("mystery", "medium");
  assert.equal(pick.model, "mystery-b");
  assert.equal(pick.costAware, false);
});
