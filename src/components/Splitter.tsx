import { type Component, onCleanup } from "solid-js";
import { beginResize, endResize } from "@/stores/panes";

/**
 * A draggable vertical divider between two panels.
 *
 * # Why pointer capture rather than window listeners
 *
 * `setPointerCapture` routes every subsequent move and the release to this
 * element, whatever the cursor is over. Without it a drag that outruns the
 * pointer — which any drag does, the panel is laid out after the event — leaves
 * the handle behind, the mouse ends up over the listing, and the divider stops
 * following. It also means the listeners live on the element and die with it:
 * no window listener to unregister, and none of the `onCleanup`-after-await
 * trap that already cost this project a duplicated drop handler (commit
 * 1c85d97).
 *
 * # Why the width is recomputed from the press, not accumulated
 *
 * Each move reports `origin + (x - originX)` rather than adding a delta. The
 * accumulating version drifts the moment the width hits its clamp: the mouse
 * keeps travelling, the panel cannot, and the two are then permanently out of
 * step — the divider only starts moving again after the cursor has come all the
 * way back.
 */
const Splitter: Component<{
  /** Current width of the panel to the left, in px. */
  width: number;
  onResize: (px: number) => void;
  /** Double-click restores the default width. */
  onReset: () => void;
  label: string;
}> = (props) => {
  let originX = 0;
  let originWidth = 0;
  let active = false;

  const stop = () => {
    if (!active) return;
    active = false;
    endResize();
  };

  // Belt and braces: if the component goes away mid-drag (a hot reload, a
  // storage switch that re-renders the shell), the shell must not stay stuck in
  // "resizing" with text selection disabled everywhere.
  onCleanup(stop);

  return (
    <div
      class="group relative z-10 cursor-col-resize bg-border"
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      onPointerDown={(e) => {
        // Only the primary button, and no text-selection start.
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        originX = e.clientX;
        originWidth = props.width;
        active = true;
        beginResize();
      }}
      onPointerMove={(e) => {
        if (!active) return;
        props.onResize(originWidth + (e.clientX - originX));
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDblClick={() => props.onReset()}
    >
      {/* The line is 1px so the layout reads as one hairline; the grab area is
          9px, centred on it and spilling over both neighbours. A 1px hit target
          is a divider the user has to aim at. */}
      <span class="absolute inset-y-0 -left-1 -right-1 group-hover:bg-accent/40" />
    </div>
  );
};

export default Splitter;
