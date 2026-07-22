// Shared helpers for the Settings organism's per-tab sections: a debounced auto-save for typed
// inputs, and terse save/fail toasts. Extracted from organisms/Settings.js (P6 split).
import { useEffect, useRef } from "/web/vendor/standalone.mjs";
import { toast } from "../../../lib/toast.js";

// Debounced auto-save for typed inputs: save 600ms after the last keystroke (checkboxes/selects
// save immediately at the call site).
export function useAutoSave() {
  const t = useRef(null);
  useEffect(() => () => clearTimeout(t.current), []);
  return (fn) => { clearTimeout(t.current); t.current = setTimeout(fn, 600); };
}
export const saved = () => toast("Saved");
export const failed = (e) => toast((e && e.message) || "Couldn't save", "error");
