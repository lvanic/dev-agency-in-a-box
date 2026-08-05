// Issue bodies come from GitHub and carry GitHub-flavoured HTML. The renderer escapes everything
// (correct — that is the XSS boundary), which meant two of OUR OWN constructs showed as literal tag
// soup in the thread: the epic tracker's HTML comment markers, and the <details> fold wrapping the
// spec anchor — so every generated issue opened with its full original request expanded inline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// markdown.js imports the preact standalone bundle by absolute URL, which node can't resolve — the
// pure string helpers are what we're testing, so evaluate the module with that import stripped.
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "web", "lib", "markdown.js"), "utf8")
  .replace(/^import .*$/gm, "");
const { md, mdInline } = await import("data:text/javascript," + encodeURIComponent(src));

test("a <details> fold becomes a real collapsible, not literal tags", () => {
  const out = md("intro\n\n<details><summary>Original request</summary>\n\nbuild the thing\n\n</details>\n\ntail");
  assert.match(out, /<details class="mdfold"><summary>Original request<\/summary>/);
  assert.match(out, /build the thing/);
  assert.match(out, /<\/details>/);
  assert.doesNotMatch(out, /&lt;details&gt;/, "the raw tag must not survive as escaped text");
  assert.match(out, /intro/);
  assert.match(out, /tail/, "content after the fold must still render");
});

test("fold contents are still escaped — the shell is ours, the body is not", () => {
  const out = md('<details><summary>x</summary>\n\n<img src=x onerror="alert(1)">\n\n</details>');
  assert.doesNotMatch(out, /<img src=x onerror/, "user markup inside a fold must not be injected raw");
  assert.match(out, /&lt;img/);
});

test("a hostile summary cannot break out of the summary element", () => {
  const out = md('<details><summary></summary><script>alert(1)</script></summary>\n\nbody\n\n</details>');
  assert.doesNotMatch(out, /<script>/, "no script tag may reach the DOM");
});

test("HTML comment markers are dropped, not printed", () => {
  const out = md("done\n\n<!-- epic-tracker -->");
  assert.doesNotMatch(out, /epic-tracker/, "bookkeeping markers are not for the reader");
  assert.match(out, /done/);
});

test("underscore emphasis renders, snake_case does not", () => {
  assert.match(mdInline("status _(open)_ here"), /<em>\(open\)<\/em>/);
  assert.doesNotMatch(mdInline("call some_function_name now"), /<em>/, "snake_case must be left alone");
  assert.doesNotMatch(mdInline("a __dunder__ name"), /<em>/, "double underscores are not single emphasis");
});

test("bodies without folds render exactly as before", () => {
  const out = md("# Title\n\n- one\n- two\n\n**bold**");
  assert.match(out, /<h1>Title<\/h1>/);
  assert.match(out, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(out, /<strong>bold<\/strong>/);
});
