// Agency logo — the whole team standing in an overlapping lineup, like a group waiting for work.
// Full-body persona art (one distinct figure per role, mixed-gender) fanned out in a little box next
// to the wordmark. Hovering a figure lifts it to the front; it drops back the moment you leave.
// On a narrow screen the whole crowd collapses to a single figure (see .agency-logo CSS in shell.ts).
import { html } from "/web/vendor/standalone.mjs";
import { playVoice } from "/web/lib/sound.js";

// Exact avatar filenames in web/avatars/ — NOT roles, so they map 1:1 to distinct art (no dupes).
const TEAM = ["planner-f", "architect", "developer-f", "reviewer", "tester", "librarian-f", "auditor"];
// The figure's art filename → its agent role (drop the "-f" gender-variant suffix) so each persona
// speaks in its own voice on hover. Sweep across the lineup and the whole team talks, one by one.
const roleOf = (name) => name.replace(/-f$/, "");

export const AgencyLogo = ({ size = 30 }) => {
  const w = Math.round(size * 0.83);
  return html`<span class="agency-logo" style=${"height:" + size + "px"} title="The agency — waiting for work (hover a face to hear them)">
    ${TEAM.map((name) => html`<span key=${name} class="agency-logo__fig" style=${"width:" + w + "px"} onMouseEnter=${() => playVoice(roleOf(name))}><img src=${"/web/avatars/" + name + ".svg"} alt="" loading="lazy" draggable="false"/></span>`)}
  </span>`;
};
