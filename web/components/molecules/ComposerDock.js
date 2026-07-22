// ComposerDock molecule — the Detail drawer's reply composer: the shared ChatComposer plus its
// Detail-specific extras (address-an-agent picker, model override picker) and the running-only
// Interrupt action. Extracted from organisms/Detail.js (P6 split); logic unchanged.
import { html } from "/web/vendor/standalone.mjs";
import { Icon } from "../atoms/Icon.js";
import { Spinner } from "../atoms/Spinner.js";
import { Select } from "../atoms/Select.js";
import { ChatComposer } from "./ChatComposer.js";
import { ModelSelect } from "./ModelSelect.js";

export function ComposerDock({
  reply, setReply, taRef, repo, number, running, busy, sendFull,
  replyAgent, setReplyAgent, agentSelOpts, providers, data, modelOverride, updateModelOverride,
  modelTrigger, defModelLabel, onOpenModels, act,
}) {
  return html`<div class="dcompose">
    <${ChatComposer}
      value=${reply} onInput=${setReply} taRef=${taRef}
      uploadCtx=${{ repo, number }}
      placeholder=${running ? "Message the agent…  (queued until the run finishes)" : "Reply…  (Cmd+Enter sends, paste image to embed)"}
      busy=${busy}
      sendLabel=${running ? "Nudge" : "Send"} sendIcon=${running ? "messages" : "send"}
      onSend=${sendFull}
      extras=${html`<${Select} value=${replyAgent} options=${agentSelOpts} onChange=${setReplyAgent} placeholder="Just comment"/>
        <${ModelSelect} providers=${providers} data=${data} value=${modelOverride} emit="object" onChange=${updateModelOverride} includeDefault=${true} defaultLabel="Default model" defaultHint=${defModelLabel} onSetUp=${onOpenModels} btnClass="iconbtn" trigger=${modelTrigger}/>`}
      actions=${running ? html`<button class=${"btn tip" + (act.isBusy("hold", repo, number) ? " busy" : "")} data-tip="Interrupt & steer — pauses the workflow at the next safe break and folds your message into the next step" disabled=${act.isBusy("hold", repo, number)} onClick=${() => { const t = reply.trim(); act.hold(repo, number, t); if (t) setReply(""); }}>${act.isBusy("hold", repo, number) ? html`<${Spinner} size=${15}/>` : html`<${Icon} name="stop" size=${15}/>`} Interrupt</button>` : null}
    />
  </div>`;
}
