import { type Component, Show } from "solid-js";
import { AlertCircle, X } from "lucide-solid";
import { platform } from "@tauri-apps/plugin-os";
import { t } from "@/i18n";
import type { AdxError } from "@/ipc/types";
import { formatBytes } from "@/lib/format";

/**
 * How every failure reaches the user: one short sentence in the interface
 * language, the remediation when there is one, and the technical text folded
 * away until asked for.
 *
 * One component rather than a banner per panel. The three places that show
 * errors — the device list, the listing, the operations panel — were each
 * rendering `kind` and `message` their own way, which meant the remediation for
 * a held device existed in exactly one of them and the raw message was pasted
 * in front of the user in all three. A person who cannot act on
 * "MTP transaction 0x1002 failed" should not have to read it to find the
 * sentence that they can act on.
 *
 * The technical text is never dropped, only folded: it is the only thing worth
 * having in a bug report, and an app that hides it entirely turns every report
 * into a guessing game.
 */

/**
 * `platform()` reads globals Tauri injects into the window, so it throws
 * anywhere else — a test renderer, a plain `vite dev` page. The fallback is not
 * "unknown platform" but "do not show a platform-specific hint", which is the
 * safe answer: a Linux command shown on macOS is worse than no command at all.
 */
function isLinux(): boolean {
  try {
    return platform() === "linux";
  } catch {
    return false;
  }
}

const ErrorBanner: Component<{
  error: AdxError;
  /** Omitted where the banner clears itself — the listing's, which every
   *  re-read replaces, and the device list's, which Refresh drops. */
  onDismiss?: () => void;
}> = (props) => (
  <div class="flex items-start gap-2 rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">
    <AlertCircle size={13} class="mt-0.5 shrink-0" />
    <div class="min-w-0 flex-1 space-y-1">
      <div class="font-medium">{t()(`errors.${props.error.kind}`)}</div>

      {/* Named, not described: "another process" is what the user already
          knows. The name and pid are what lets them go and close it. */}
      <Show when={props.error.holder}>
        {(h) => (
          <div class="space-y-0.5">
            <div class="font-mono opacity-80">
              {h().name}
              <Show when={h().pid > 0}> ({h().pid})</Show>
            </div>
            <div class="opacity-80">{t()("errors.occupied_hint")}</div>
          </div>
        )}
      </Show>

      {/* Both figures, because "not enough space" alone leaves the user
          guessing whether to delete one video or a hundred. */}
      <Show when={props.error.space}>
        {(s) => (
          <div class="opacity-80">
            {t()("errors.space_detail", {
              required: formatBytes(s().required),
              free: formatBytes(s().free),
            })}
          </div>
        )}
      </Show>

      <Show when={props.error.kind === "permission_denied" && isLinux()}>
        <div class="space-y-1">
          <div class="opacity-80">{t()("errors.permission_hint")}</div>
          {/* `select-text` explicitly: the shell turns off text selection for
              the whole app, and a command the user cannot copy is a command
              they have to retype without a typo. */}
          <pre class="select-text overflow-x-auto rounded border border-danger/30 bg-danger/5 p-1.5 font-mono text-[11px] leading-relaxed">
            {LINUX_UDEV_COMMANDS}
          </pre>
        </div>
      </Show>

      <Show when={props.error.message}>
        <details class="opacity-80">
          <summary class="cursor-pointer select-none">{t()("errors.detail")}</summary>
          <div class="mt-0.5 select-text break-words font-mono text-[11px]">
            {props.error.message}
          </div>
        </details>
      </Show>
    </div>

    <Show when={props.onDismiss}>
      {(dismiss) => (
        <button
          class="shrink-0 opacity-60 hover:opacity-100"
          title={t()("errors.dismiss")}
          onClick={() => dismiss()()}
        >
          <X size={12} />
        </button>
      )}
    </Show>
  </div>
);

/**
 * Left untranslated on purpose — these are commands, and a translated shell
 * command is a broken one.
 *
 * The vendor id is a placeholder rather than a real number: it differs per
 * manufacturer, and the error does not carry the ids of a device it failed to
 * open. `lsusb` is the step that turns the placeholder into the user's own
 * value, so it is part of the instruction rather than assumed.
 *
 * Untested: nobody has run ADX on Linux yet. This is the standard udev remedy
 * for userspace USB access, not a recipe this project has verified.
 */
const LINUX_UDEV_COMMANDS = `lsusb
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="XXXX", MODE="0666"' | sudo tee /etc/udev/rules.d/99-adx.rules
sudo udevadm control --reload-rules && sudo udevadm trigger`;

export default ErrorBanner;
