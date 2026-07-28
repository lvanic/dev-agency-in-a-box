// MultiQuestionPicker molecule — the answer form for an agent's question(s), pinned above the reply
// box. Renders ONE or SEVERAL questions; each shows its prompt, then either option CARDS (a bold
// label + a one-line description, so the choice is self-explanatory without hunting the prose above)
// or a free-text box when it has no options. Single-select = pick one card; multi = tick several.
// Answers are collected across all questions and sent as ONE readable reply on Submit — no new backend
// route needed, the composed answer is just a pre-filled human reply the planner reads back.
import { html, useState } from "/web/vendor/standalone.mjs";
import { Icon } from "../atoms/Icon.js";
import { Spinner } from "../atoms/Spinner.js";

function normOpt(o) {
  if (o && typeof o === "object") {
    const label = String(o.label ?? o.l ?? o.value ?? "");
    return { label, value: String(o.value ?? o.label ?? o.l ?? ""), desc: String(o.desc ?? o.d ?? "") };
  }
  const s = String(o ?? "");
  return { label: s, value: s, desc: "" };
}

export function MultiQuestionPicker({ questions, onPick }) {
  const qs = (Array.isArray(questions) ? questions : [])
    .map((q) => ({ prompt: String(q.prompt ?? q.q ?? "").trim(), options: (q.options || []).map(normOpt).filter((o) => o.label), multi: !!q.multi }))
    .filter((q) => q.prompt || q.options.length);
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
  const single = qs.length === 1;

  function submit() {
    if (busy || done || !allAnswered) return;
    setBusy(true);
    // One reply. With several questions, prefix each answer with its prompt so the mapping is clear;
    // with a single question, just send the answer (the prompt is already on screen).
    const text = qs.map((q, i) => (single || !q.prompt) ? answerOf(q, i) : `**${q.prompt}** → ${answerOf(q, i)}`).join("\n");
    Promise.resolve(onPick && onPick(text)).then(() => setDone(true)).catch(() => {}).finally(() => setBusy(false));
  }

  if (done) {
    return html`<div class="optpick optpick-done"><${Icon} name="check" size=${13}/> <span>Answered</span></div>`;
  }
  return html`<div class="mqpick">
    ${qs.map((q, i) => html`<div class="mqpick-q" key=${i}>
      ${q.prompt ? html`<div class="mqpick-prompt">${q.prompt}</div>` : null}
      ${q.options.length ? html`<div class="qopts">
        ${q.options.map((o, j) => {
          const on = (Array.isArray(ans[i]) ? ans[i] : []).includes(o.value);
          return html`<button type="button" class=${"qopt" + (on ? " on" : "")} key=${j} disabled=${busy} onClick=${() => choose(i, o.value, q.multi)}>
            <span class=${"qopt-mark" + (q.multi ? " box" : " dot")}><${Icon} name="check" size=${12}/></span>
            <span class="qopt-body"><span class="qopt-label">${o.label}</span>${o.desc ? html`<span class="qopt-desc">${o.desc}</span>` : null}</span>
          </button>`;
        })}
      </div>` : html`<textarea class="mqpick-text" rows="2" placeholder="Type your answer…" disabled=${busy} value=${typeof ans[i] === "string" ? ans[i] : ""} onInput=${(e) => setText(i, e.target.value)}></textarea>`}
    </div>`)}
    <button class="qsubmit" disabled=${busy || !allAnswered} onClick=${submit}>${busy ? html`<${Spinner} size=${13}/> ` : null}${single ? "Send answer" : "Submit answers"}</button>
  </div>`;
}
