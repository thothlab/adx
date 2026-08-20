import { type Component, createResource, Show } from "solid-js";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { CheckCircle2, Download } from "lucide-solid";
import { t } from "@/i18n";
import { api, asAdxError } from "@/ipc/client";
import ErrorBanner from "@/components/ErrorBanner";
import { Button, Modal } from "@/components/Modal";

/**
 * «Проверить наличие обновлений…» — the answer, in a dialog.
 *
 * Three outcomes, and all three say something. A check that quietly does
 * nothing when you are up to date is indistinguishable from a menu item that is
 * broken, which is why "you have the newest one" is a state with a tick next to
 * it rather than a dialog that fails to appear.
 *
 * The download is a link out, not a button that installs. The builds are
 * unsigned — see `src-tauri/src/update.rs` for why fetching and running one
 * automatically would be the wrong favour to do anyone.
 */
const UpdateCheck: Component<{ onClose: () => void }> = (props) => {
  // A resource rather than a signal and an effect: the request starts when the
  // dialog mounts, which is exactly when the user asked for it, and its three
  // states are the three things the dialog has to render.
  const [check] = createResource(() => api.update.check());

  return (
    <Modal
      title={t()("update.title")}
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>{t()("dialog.close")}</Button>
          <Show when={check()?.outdated && check()?.url}>
            {(url) => (
              <Button variant="primary" onClick={() => void openExternal(url())}>
                {t()("update.open_page")}
              </Button>
            )}
          </Show>
        </>
      }
    >
      <Show
        when={!check.loading}
        fallback={<div class="text-fg-muted">{t()("update.checking")}</div>}
      >
        <Show
          when={!check.error}
          fallback={
            <ErrorBanner
              error={{
                ...asAdxError(check.error),
                // The kind carries no useful distinction here — every way this
                // can fail is "we could not ask" — but the technical text does,
                // and `ErrorBanner` is what folds it away until wanted.
                kind: "io",
              }}
            />
          }
        >
          <Show
            when={check()?.outdated}
            fallback={
              <div class="flex items-start gap-2">
                <CheckCircle2 size={14} class="mt-0.5 shrink-0 text-success" />
                <div>
                  <div>{t()("update.current")}</div>
                  <div class="mt-0.5 text-fg-muted">
                    {t()("update.version", { version: check()?.current ?? "" })}
                  </div>
                </div>
              </div>
            }
          >
            <div class="flex items-start gap-2">
              <Download size={14} class="mt-0.5 shrink-0 text-accent" />
              <div>
                <div>{t()("update.available", { version: check()?.latest ?? "" })}</div>
                <div class="mt-0.5 text-fg-muted">
                  {t()("update.version", { version: check()?.current ?? "" })}
                </div>
                {/* Said before they go, not after they have downloaded it and
                    met Gatekeeper with no idea why. */}
                <div class="mt-1.5 text-fg-muted">{t()("update.unsigned")}</div>
              </div>
            </div>
          </Show>
        </Show>
      </Show>
    </Modal>
  );
};

export default UpdateCheck;
