import { type Component, createSignal, For, type JSX, onMount, Show } from "solid-js";
import { t } from "@/i18n";

/**
 * Dialogs.
 *
 * `confirm()` and `prompt()` are not merely discouraged in a Tauri WKWebView —
 * they are inert. They return immediately with the "cancel" answer and no
 * window ever appears, so a delete guarded by `confirm()` silently deletes and
 * a rename guarded by `prompt()` silently does nothing. Source:
 * `Projects/Pane/Правки`, commit 81dc73e. Hence these.
 */

export const Modal: Component<{
  title: string;
  onClose: () => void;
  children: JSX.Element;
  footer: JSX.Element;
}> = (props) => (
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    onClick={(e) => {
      if (e.target === e.currentTarget) props.onClose();
    }}
  >
    <div class="w-full max-w-md rounded-lg border border-border bg-bg shadow-xl">
      <header class="border-b border-border px-4 py-2.5 text-sm font-medium">{props.title}</header>
      <div class="px-4 py-3 text-xs text-fg-subtle">{props.children}</div>
      <footer class="flex justify-end gap-2 border-t border-border px-4 py-2.5">
        {props.footer}
      </footer>
    </div>
  </div>
);

export const Button: Component<{
  children: JSX.Element;
  onClick: () => void;
  variant?: "primary" | "danger" | "plain";
  disabled?: boolean;
  title?: string;
}> = (props) => (
  <button
    class="rounded border px-2.5 py-1 text-xs disabled:opacity-40"
    classList={{
      "border-accent bg-accent text-white hover:opacity-90": props.variant === "primary",
      "border-danger bg-danger text-white hover:opacity-90": props.variant === "danger",
      "border-border hover:bg-bg-muted": !props.variant || props.variant === "plain",
    }}
    title={props.title}
    disabled={props.disabled}
    onClick={() => props.onClick()}
  >
    {props.children}
  </button>
);

/**
 * A single-field dialog, used for "new folder" and "rename".
 *
 * `problem` is asked on every keystroke and both blocks the button and explains
 * why. Answering before the round trip is the point: the device's own refusal
 * of an impossible name arrives as a protocol error after a wait, which reads
 * as the app being broken rather than as the name being wrong.
 */
export const PromptModal: Component<{
  title: string;
  label: string;
  initial?: string;
  confirmLabel: string;
  /** Returns a message when the typed name cannot be used, `null` otherwise. */
  problem?: (value: string) => string | null;
  onConfirm: (value: string) => void;
  onClose: () => void;
}> = (props) => {
  const [value, setValue] = createSignal(props.initial ?? "");
  let input: HTMLInputElement | undefined;

  // Once, when the dialog opens: focus the field and preselect the stem, so
  // renaming "photo.jpg" does not mean retyping the extension.
  //
  // `onMount`, not `createEffect`. An effect reading `value()` re-runs on every
  // keystroke and re-selects the stem each time, so the next character replaces
  // what was just typed and the field never holds more than one — a rename
  // dialog that cannot be typed into. It was written as an effect and looked
  // right; nothing catches it except typing a whole name into it.
  onMount(() => {
    const initial = props.initial ?? "";
    const dot = initial.lastIndexOf(".");
    input?.focus();
    input?.setSelectionRange(0, dot > 0 ? dot : initial.length);
  });

  const problem = () => props.problem?.(value()) ?? null;
  const ready = () => Boolean(value().trim()) && !problem();

  const submit = () => {
    // Guarded here as well as on the button: Enter reaches this directly, and a
    // dialog that refuses the click but accepts the keystroke is worse than one
    // that never checked.
    if (ready()) props.onConfirm(value().trim());
  };

  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>{t()("dialog.cancel")}</Button>
          <Button variant="primary" disabled={!ready()} onClick={submit}>
            {props.confirmLabel}
          </Button>
        </>
      }
    >
      <label class="block space-y-1">
        <span class="text-fg-muted">{props.label}</span>
        <input
          ref={input}
          class="w-full rounded border bg-bg-subtle px-2 py-1 text-xs text-fg outline-none"
          classList={{
            "border-danger": Boolean(problem()),
            "border-border focus:border-accent": !problem(),
          }}
          value={value()}
          // macOS rewrites straight quotes and apostrophes into typographic
          // ones inside text inputs. A filename that gains a "smart" quote no
          // longer matches the file the user meant. Source: Pane, c5ebae3.
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
          onInput={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") props.onClose();
          }}
        />
      </label>
      {/* Reserved rather than inserted: a line appearing under the field pushes
          the footer down and moves the button out from under the cursor at the
          moment the user is reaching for it. */}
      <div class="mt-1 min-h-4 text-danger">{problem()}</div>
    </Modal>
  );
};

/** A yes/no dialog with an optional list of affected names. */
export const ConfirmModal: Component<{
  title: string;
  body: string;
  names?: string[];
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}> = (props) => (
  <Modal
    title={props.title}
    onClose={props.onClose}
    footer={
      <>
        <Button onClick={props.onClose}>{t()("dialog.cancel")}</Button>
        <Button variant={props.danger ? "danger" : "primary"} onClick={props.onConfirm}>
          {props.confirmLabel}
        </Button>
      </>
    }
  >
    <p>{props.body}</p>
    <Show when={props.names?.length}>
      <ul class="mt-2 max-h-40 overflow-auto rounded border border-border bg-bg-subtle p-2 font-mono text-xs">
        <For each={props.names}>{(n) => <li class="truncate">{n}</li>}</For>
      </ul>
    </Show>
  </Modal>
);
