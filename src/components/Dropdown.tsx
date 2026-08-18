import { type Component, createSignal, type JSX, onCleanup, Show } from "solid-js";
import { ChevronDown } from "lucide-solid";

/**
 * A toolbar button that opens a short menu under itself.
 *
 * The rest of the toolbar is deliberately flat — one visible button per action
 * — and this is the one place that earns a menu: copying to the computer is one
 * intent with two destinations (a folder the user picks, or the standard
 * Downloads folder), and two more top-level buttons for the same verb would
 * read as two different features.
 */
export const Dropdown: Component<{
  label: JSX.Element;
  title?: string;
  disabled?: boolean;
  children: (close: () => void) => JSX.Element;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;

  const close = () => setOpen(false);

  // Registered synchronously, unregistered synchronously. The `document`
  // listener is what closes the menu on a click anywhere else, and a leaked one
  // survives every hot reload and starts closing menus that belong to a later
  // instance — the same shape of leak that once duplicated this app's Finder
  // drop handler (commit 1c85d97).
  const onDocumentPointerDown = (e: PointerEvent) => {
    if (root && !root.contains(e.target as Node)) close();
  };
  const onDocumentKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("pointerdown", onDocumentPointerDown);
  document.addEventListener("keydown", onDocumentKeyDown);
  onCleanup(() => {
    document.removeEventListener("pointerdown", onDocumentPointerDown);
    document.removeEventListener("keydown", onDocumentKeyDown);
  });

  return (
    <div class="relative" ref={root}>
      <button
        class="flex items-center gap-1 rounded border border-border px-2.5 py-1 text-xs hover:bg-bg-muted disabled:opacity-40"
        title={props.title}
        disabled={props.disabled}
        onClick={() => setOpen(!open())}
      >
        {props.label}
        <ChevronDown size={11} class="text-fg-muted" />
      </button>

      <Show when={open()}>
        <div class="absolute left-0 top-full z-30 mt-1 min-w-56 overflow-hidden rounded-md border border-border bg-bg py-1 shadow-lg">
          {props.children(close)}
        </div>
      </Show>
    </div>
  );
};

/** One line in a `Dropdown`. */
export const DropdownItem: Component<{
  children: JSX.Element;
  onClick: () => void;
  disabled?: boolean;
}> = (props) => (
  <button
    class="block w-full px-3 py-1.5 text-left text-xs hover:bg-bg-muted disabled:opacity-40 disabled:hover:bg-transparent"
    disabled={props.disabled}
    onClick={() => props.onClick()}
  >
    {props.children}
  </button>
);

export default Dropdown;
