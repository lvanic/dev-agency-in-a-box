// OptionPicker molecule — renders an agent's clickable answer choices (Claude-Code style). Single-pick
// questions are one-tap buttons; multi-pick questions are checkboxes + a Submit button. Picking sends
// the chosen text back through the surface's normal send path (orchestrator chat OR run-thread reply),
// so no new backend route is needed — the click is just a pre-composed human reply.
import { html, useState } from "/web/vendor/standalone.mjs";
import { Icon } from "../atoms/Icon.js";
import { Spinner } from "../atoms/Spinner.js";

// A wire option is a plain string (label == what's sent) or {label, value} (value is sent, e.g. an
// approve button labelled "👍 Build it" that actually sends "ok"). Normalize to {label, value}.
function normOpt(o) {
  if (o && typeof o === "object") return { label: String(o.label ?? o.value ?? ""), value: String(o.value ?? o.label ?? "") };
  const s = String(o ?? "");
  return { label: s, value: s };
}

export function OptionPicker({ question, onPick, disabled }) {
  const opts = (question && Array.isArray(question.options) ? question.options : []).map(normOpt).filter((o) => o.label);
  const multi = !!(question && question.multi);
  const [sel, setSel] = useState([]); // selected values (multi only)
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // the label(s) that were sent, once picked
  if (!opts.length) return null;

  function send(text, shownLabel) {
    if (busy || done) return;
    setBusy(true);
    Promise.resolve(onPick && onPick(text))
      .then(() => setDone(shownLabel))
      .catch(() => {})
      .finally(() => setBusy(false));
  }
  function toggle(v) {
    setSel((s) => (s.includes(v) ? s.filter((x) => x !== v) : s.concat(v)));
  }
  function submitMulti() {
    const chosen = opts.filter((o) => sel.includes(o.value));
    if (!chosen.length) return;
    send(chosen.map((o) => o.value).join(", "), chosen.map((o) => o.label).join(", "));
  }

  if (done) {
    return html`<div class="optpick optpick-done"><${Icon} name="check" size=${13}/> <span>${done}</span></div>`;
  }
  const off = disabled || busy;

  if (!multi) {
    return html`<div class="optpick">
      ${opts.map((o, i) => html`<button class="optpick-btn" key=${i} disabled=${off} onClick=${() => send(o.value, o.label)}>${busy ? html`<${Spinner} size=${12}/> ` : null}${o.label}</button>`)}
    </div>`;
  }
  return html`<div class="optpick optpick-multi">
    ${opts.map((o, i) => html`<label class=${"optpick-chk" + (sel.includes(o.value) ? " on" : "")} key=${i}>
      <input type="checkbox" checked=${sel.includes(o.value)} disabled=${off} onChange=${() => toggle(o.value)}/>
      <span class="optpick-box"><${Icon} name="check" size=${11}/></span>
      <span>${o.label}</span>
    </label>`)}
    <button class="optpick-btn optpick-submit" disabled=${off || !sel.length} onClick=${submitMulti}>${busy ? html`<${Spinner} size=${12}/> ` : null}Submit${sel.length ? ` (${sel.length})` : ""}</button>
  </div>`;
}
