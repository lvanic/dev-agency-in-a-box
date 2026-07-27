// Agency logo — the whole team standing in an overlapping lineup, like a group waiting for work.
// Full-body persona art fanned out in a little box next to the wordmark. Hovering a figure lifts it
// to the front; it STAYS lifted after the pointer leaves (each face you look at steps forward and
// waits). Click a lifted figure to send it back into the crowd.
import { html, useState } from "/web/vendor/standalone.mjs";
import { avatarFile } from "./Avatar.js";

// One figure per role — a mixed-gender team, left-to-right in workflow order.
const TEAM = ["planner-f", "architect", "developer-f", "reviewer", "tester", "librarian-f", "auditor"];

export const AgencyLogo = ({ size = 30 }) => {
  // `lifted` maps index -> z so the most-recently-hovered figure sits fully in front and holds there.
  const [lifted, setLifted] = useState({});
  const [z, setZ] = useState(10);
  function lift(i) { setZ((n) => { const nz = n + 1; setLifted((m) => ({ ...m, [i]: nz })); return nz; }); }
  function drop(i, e) { e.stopPropagation(); setLifted((m) => { const n = { ...m }; delete n[i]; return n; }); }
  const w = Math.round(size * 0.83);
  return html`<span class="agency-logo" style=${"height:" + size + "px"} title="The agency — waiting for work">
    ${TEAM.map((name, i) => html`<span
      key=${name}
      class=${"agency-logo__fig" + (lifted[i] ? " up" : "")}
      style=${"width:" + w + "px;z-index:" + (lifted[i] || i)}
      onMouseEnter=${() => lift(i)}
      onClick=${(e) => lifted[i] && drop(i, e)}
    ><img src=${avatarFile(name, "full")} alt="" loading="lazy" draggable="false"/></span>`)}
  </span>`;
};
