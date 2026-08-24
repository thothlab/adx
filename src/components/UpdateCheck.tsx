import { type Component, createResource, createSignal, Show } from "solid-js";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { check as checkUpdate, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { CheckCircle2, Download } from "lucide-solid";
import { t } from "@/i18n";
import { api, asAdxError } from "@/ipc/client";
import { formatBytes } from "@/lib/format";
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
 * # Two ways forward, and which one appears depends on what can be verified
 *
 * Installing from here is possible because every release is signed with the
 * project's update key (minisign, not Apple's) and the updater refuses anything
 * that does not match the public half baked into this bundle. That is the whole
 * reason the button exists at all: an updater that ran an unverified binary
 * would turn "the builds are unsigned by Apple" from an inconvenience into a
 * remote code execution path.
 *
 * The link to the release page stays for the case the signed path cannot cover:
 * releases published before the updater existed carry no manifest, and a
 * `.deb` or `.rpm` belongs to the package manager rather than to us. Then the
 * honest answer is the page, with the Gatekeeper warning said in advance.
 */
const UpdateCheck: Component<{ onClose: () => void }> = (props) => {
  // A resource rather than a signal and an effect: the request starts when the
  // dialog mounts, which is exactly when the user asked for it, and its three
  // states are the three things the dialog has to render.
  const [check] = createResource(() => api.update.check());

  /**
   * The same question asked of the updater: is there a *signed* build for this
   * platform? Answered separately from the one above, because the two can
   * disagree and each disagreement means something. A release with no manifest
   * — everything published before 1.0.5, and any build the workflow failed to
   * sign — is visible to GitHub and invisible here, and that is exactly when
   * the user must be sent to the page instead of offered a button.
   */
  const [signed] = createResource(async (): Promise<Update | null> => {
    try {
      return await checkUpdate();
    } catch {
      // Not surfaced: the check above is the one that decides whether there is
      // anything to say, and a missing manifest is not an error the user can
      // act on — it just means the other path.
      return null;
    }
  });

  const [installing, setInstalling] = createSignal(false);
  const [done, setDone] = createSignal(0);
  const [total, setTotal] = createSignal(0);
  const [installed, setInstalled] = createSignal(false);
  const [failure, setFailure] = createSignal<unknown>(null);

  const install = async (update: Update) => {
    setInstalling(true);
    setFailure(null);
    setDone(0);
    setTotal(0);
    try {
      await update.downloadAndInstall((e) => {
        // Three events, and each one moves the same two numbers: the length
        // arrives first, then chunks, then nothing. A bar that only appears
        // once the size is known is better than one that guesses.
        if (e.event === "Started") setTotal(e.data.contentLength ?? 0);
        else if (e.event === "Progress") setDone((was) => was + e.data.chunkLength);
      });
      setInstalled(true);
    } catch (e) {
      setFailure(e);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Modal
      title={t()("update.title")}
      onClose={props.onClose}
      footer={
        <>
          <Button onClick={props.onClose}>{t()("dialog.close")}</Button>

          {/* Installed and waiting: the only thing left is to start the new
              one, and it is the primary action because nothing else here
              matters until it happens. */}
          <Show when={installed()}>
            <Button variant="primary" onClick={() => void relaunch()}>
              {t()("update.restart")}
            </Button>
          </Show>

          <Show when={check()?.outdated && !installed()}>
            {/* The page stays available even when the button is there: a user
                who would rather see what they are installing should not have to
                take our word for it. */}
            <Show when={check()?.url}>
              {(url) => (
                <Button onClick={() => void openExternal(url())}>
                  {t()("update.open_page")}
                </Button>
              )}
            </Show>
            <Show when={signed()}>
              {(update) => (
                <Button
                  variant="primary"
                  disabled={installing()}
                  onClick={() => void install(update())}
                >
                  {t()("update.install")}
                </Button>
              )}
            </Show>
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
                {/* What happens next, and it differs by path: the button
                    verifies a signature and replaces the app in place, the page
                    hands over a file macOS will question on first launch. Said
                    before the user goes, not after they have met Gatekeeper
                    with no idea why. */}
                <Show
                  when={signed()}
                  fallback={<div class="mt-1.5 text-fg-muted">{t()("update.unsigned")}</div>}
                >
                  <div class="mt-1.5 text-fg-muted">{t()("update.verified")}</div>
                </Show>

                <Show when={installing()}>
                  <div class="mt-2 text-fg-muted">
                    <Show
                      when={total()}
                      fallback={t()("update.downloading_start")}
                    >
                      {t()("update.downloading", {
                        done: formatBytes(done()),
                        total: formatBytes(total()),
                      })}
                    </Show>
                  </div>
                </Show>

                <Show when={installed()}>
                  <div class="mt-2 flex items-start gap-2 text-success">
                    <CheckCircle2 size={14} class="mt-0.5 shrink-0" />
                    <span>{t()("update.installed")}</span>
                  </div>
                </Show>

                <Show when={failure()}>
                  <div class="mt-2">
                    <ErrorBanner error={{ ...asAdxError(failure()), kind: "io" }} />
                  </div>
                </Show>
              </div>
            </div>
          </Show>
        </Show>
      </Show>
    </Modal>
  );
};

export default UpdateCheck;
