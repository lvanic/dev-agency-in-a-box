// ActionDock molecule — the Detail drawer's PINNED action strip, sitting directly above the reply
// composer (never scrolls away with the conversation). Surfaces the two things that need a one-click
// response right where you type: the "Approve & build" bar when a plan is waiting, and the clickable
// answer choices when an agent asked a question (one question → OptionPicker, several → the
// MultiQuestionPicker form). Both were previously buried at the top of the scrolling thread; the plain
// Q&A prose still lives in the conversation as history.
import { html } from "/web/vendor/standalone.mjs";
import { Icon } from "../atoms/Icon.js";
import { Spinner } from "../atoms/Spinner.js";
import { OptionPicker } from "./OptionPicker.js";
import { MultiQuestionPicker } from "./MultiQuestionPicker.js";

export function ActionDock({ issue, repo, number, act, onClose, pending, onPick }) {
  const bz = (a) => act.isBusy(a, repo, number);
  const approving = issue.blocked === "awaitingApproval";
  const questions = pending && pending.questions && pending.questions.length ? pending.questions : null;
  const question = !questions && pending && pending.question ? pending.question : null;
  if (!approving && !questions && !question) return null;
  return html`<div class="pindock">
    ${approving ? html`<div class="approvebar">
      <span class="approvebar__l"><${Icon} name="check" size=${15}/> <span>Plan ready for you<small>Approve to build it, or reply below to change it.</small></span></span>
      <button class=${"btn green" + (bz("approve") ? " busy" : "")} disabled=${bz("approve")} onClick=${() => act.approve(repo, number).then(onClose)}>${bz("approve") ? html`<${Spinner} size=${14}/> Approving…` : html`<${Icon} name="check" size=${14}/> Approve & build`}</button>
    </div>` : null}
    ${(questions || question) ? html`<div class="pinq">
      <div class="pinq__l"><${Icon} name="messages" size=${14}/> ${questions ? "Answer the questions" : "Pick an answer"}</div>
      ${questions ? html`<${MultiQuestionPicker} questions=${questions} onPick=${onPick}/>` : html`<${OptionPicker} question=${question} onPick=${onPick} disabled=${false}/>`}
    </div>` : null}
  </div>`;
}
