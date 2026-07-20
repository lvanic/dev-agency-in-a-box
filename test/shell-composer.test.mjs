// #178 — the detail chat composer control row must wrap (not overflow) on narrow screens.
import test from "node:test";
import assert from "node:assert/strict";
import { renderShell } from "../dist/shell.js";

test("narrow detail pane wraps the composer control row and caps the selects", () => {
  const css = renderShell();
  // The responsive rule lives inside the detailpane container query so it only affects the
  // detail chat composer, and it must both wrap the row and cap the agent/model select width.
  assert.match(css, /@container detailpane \(max-width: 560px\)/, "narrow-pane container query present");
  assert.match(css, /\.dcompose \.composer-row\{[^}]*flex-wrap:wrap/, "composer-row wraps under 560px");
  assert.match(css, /\.dcompose \.composer-row \.sel-cur\{[^}]*max-width/, "selects are width-capped under 560px");
});
