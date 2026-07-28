// MultiQuestionPicker molecule — several questions in one round (the planner's `qs`). Each question
// renders EITHER clickable options (single/multi-select) OR, when it has no options, a free-text box —
// so open-ended asks are answered in the same pinned form. Answers are collected across ALL questions
// and sent as ONE readable reply on Submit (mirrors the SDK's AskUserQuestion UX), so no new backend
// route is needed — the composed answer is just a pre-filled human reply the planner reads back.
import { html, useState } from "/web/vendor/standalone.mjs";
import { Icon } from "../atoms/Icon.js";
import { Spinner } from "../atoms/Spinner.js";

function normOpt(o) {
  if (o && typeof o === "object") return { label: String(o.label ?? o.value ?? ""), value: String(o.value ?? o.label ?? "") };
  const s = String(o ?? "");
  return { label: s, value: s };
}

export function MultiQuestionPicker({ questions, onPick }) {
  const qs = (Array.isArray(questions) ? questions : [])
    .map((q) => ({ prompt: String(q.prompt ?? q.q ?? "").trim(), options: (q.options || []).map(normOpt).filter((o) => o.label), multi: !!q.multi }))
    .filter((q) => q.prompt);
  // ans[i] = array of chosen values (option questions) OR a string (text questions).
  const [ans, setAns] = useState({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  if (!qs.length) return null;

  function choose(qi, value, multi) {
    setAns((a) => {
      const cur = Array.isArray(a[qi]) ? a[qi] : [];
      if (multi) return { ...a, [qi]: cur.includes(value) ? cur.filter((x) => x !== value) : cur.concat(value) };
      return { ...a, [qi]: [value] };
    });
  }
  function setText(qi, v) { setAns((a) => ({ ...a, [qi]: v })); }

  const answerOf = (q, i) => q.options.length
    ? q.options.filter((o) => (Array.isArray(ans[i]) ? ans[i] : []).includes(o.value)).map((o) => o.label).join(", ")
    : String(ans[i] ?? "").trim();
  const allAnswered = qs.every((q, i) => answerOf(q, i).length > 0);

  function submit() {
    if (busy || done || !allAnswered) return;
    setBusy(true);
    // One reply, one line per question — readable for the planner and unambiguous about which answer
    // maps to which question.
    const text = qs.map((q, i) => `**${q.prompt}** → ${answerOf(q, i)}`).join("\n");
    Promise.resolve(onPick && onPick(text)).then(() => setDone(true)).catch(() => {}).finally(() => setBusy(false));
  }

  if (done) {
    return html`<div class="optpick optpick-done"><${Icon} name="check" size=${13}/> <span>Answered</span></div>`;
  }
  return html`<div class="mqpick">
    ${qs.map((q, i) => html`<div class="mqpick-q" key=${i}>
      <div class="mqpick-prompt">${q.prompt}</div>
      ${q.options.length ? html`<div class=${"optpick" + (q.multi ? " optpick-multi" : "")}>
        ${q.options.map((o, j) => {
          const on = (Array.isArray(ans[i]) ? ans[i] : []).includes(o.value);
          return html`<button class=${"optpick-btn" + (on ? " on" : "")} key=${j} disabled=${busy} onClick=${() => choose(i, o.value, q.multi)}>${q.multi ? html`<span class="optpick-box"><${Icon} name="check" size=${11}/></span> ` : null}${o.label}</button>`;
        })}
      </div>` : html`<textarea class="mqpick-text" rows="2" placeholder="Type your answer…" disabled=${busy} value=${typeof ans[i] === "string" ? ans[i] : ""} onInput=${(e) => setText(i, e.target.value)}></textarea>`}
    </div>`)}
    <button class="optpick-btn optpick-submit" disabled=${busy || !allAnswered} onClick=${submit}>${busy ? html`<${Spinner} size=${12}/> ` : null}Submit answers</button>
  </div>`;
}
