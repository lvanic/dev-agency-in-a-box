// ActionDock molecule — the Detail drawer's PINNED action strip, sitting directly above the reply
// composer (never scrolls away). Surfaces the two things that need a one-click response right where
// you type: the "Approve & build" bar when a plan is waiting, and the agent's question(s) as a
// self-explanatory answer form (prompt + option cards with descriptions, or a text box). The plain
// prose still lives in the conversation as history.
import { html } from "/web/vendor/standalone.mjs";
import { Icon } from "../atoms/Icon.js";
import { Spinner } from "../atoms/Spinner.js";
import { MultiQuestionPicker } from "./MultiQuestionPicker.js";

export function ActionDock({ issue, repo, number, act, onClose, pending, onPick }) {
  const bz = (a) => act.isBusy(a, repo, number);
  const approving = issue.blocked === "awaitingApproval";
  // Normalize to a list of questions — a single `question` and the multi `questions` render the same
  // (prompt + cards), so the form looks consistent whether the planner asked one thing or several.
  const questions = pending
    ? (pending.questions && pending.questions.length ? pending.questions : (pending.question ? [pending.question] : null))
    : null;
  if (!approving && !questions) return null;
  return html`<div class="pindock">
    ${approving ? html`<div class="approvebar">
      <span class="approvebar__l"><${Icon} name="check" size=${15}/> <span>Plan ready for you<small>Approve to build it, or reply below to change it.</small></span></span>
      <button class=${"btn green" + (bz("approve") ? " busy" : "")} disabled=${bz("approve")} onClick=${() => act.approve(repo, number).then(onClose)}>${bz("approve") ? html`<${Spinner} size=${14}/> Approving…` : html`<${Icon} name="check" size=${14}/> Approve & build`}</button>
    </div>` : null}
    ${questions ? html`<div class="pinq">
      <div class="pinq__l"><${Icon} name="messages" size=${14}/> ${questions.length > 1 ? "The agent needs your input" : "The agent has a question"}</div>
      <${MultiQuestionPicker} questions=${questions} onPick=${onPick}/>
    </div>` : null}
  </div>`;
}
