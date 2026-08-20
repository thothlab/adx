import { type Component, Show } from "solid-js";
import { LoaderCircle } from "lucide-solid";

/**
 * "This is taking a moment."
 *
 * Deliberately says nothing about how long. Reading a folder over MTP is a
 * variable number of round trips with no total known in advance, so a
 * percentage would have to be invented — and an invented bar that stalls at 80%
 * is worse than a spinner that never claimed to know.
 *
 * Callers gate this behind `createDelayed`: it appears only for work that has
 * already outlasted the point where a person starts to wonder.
 */
const Spinner: Component<{ label?: string; size?: number; class?: string }> = (props) => (
  <div class={`flex items-center gap-2 text-xs text-fg-muted ${props.class ?? ""}`}>
    <LoaderCircle size={props.size ?? 14} class="shrink-0 animate-spin" />
    <Show when={props.label}>
      <span class="truncate">{props.label}</span>
    </Show>
  </div>
);

export default Spinner;
