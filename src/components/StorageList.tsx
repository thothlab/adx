import { type Component, For, Show } from "solid-js";
import { HardDrive, Lock } from "lucide-solid";
import { t } from "@/i18n";
import { formatBytes, fraction } from "@/lib/format";
import { Button } from "@/components/Modal";
import { busy, device, refreshStorages, selectStorage, storageId, storages } from "@/stores/browser";

/**
 * Storage volumes on the open device.
 *
 * Phones ship with two of these more often than not — internal memory and an
 * SD card — and the measured device had exactly that. They are not
 * interchangeable: the card may be nearly empty while internal memory is full,
 * and a file written to the wrong one is a file the user cannot find. So the
 * choice is explicit, with the free space next to it.
 */
/**
 * What an open device with no storages means, and what to do about it.
 *
 * Not the same situation as "no device chosen", and collapsing the two is the
 * failure this app exists to avoid: with a phone selected and its session open,
 * "select a device" tells the user to do the thing they just did.
 *
 * A locked Android reports zero storages over a session that opened perfectly —
 * observed on vivo Y31 with the 1.0.0 build: `session open: vivo Y31 (0
 * storage(s))`. Unlocking the screen changes nothing on the USB side, so no
 * hotplug event arrives and nothing re-asks on its own. Hence the button: it is
 * the only way back, and without it the user is looking at an empty pane that
 * will stay empty however long they wait.
 */
const NoStorages: Component = () => (
  <div class="space-y-2 p-3 text-xs">
    <div class="text-fg-subtle">{t()("storages.none_title")}</div>
    <div class="text-fg-muted">{t()("storages.none_hint")}</div>
    <Button onClick={() => void refreshStorages()} disabled={busy()}>
      {t()("storages.none_retry")}
    </Button>
  </div>
);

const StorageList: Component = () => (
  <Show
    when={storages().length}
    fallback={
      <Show
        when={device()}
        fallback={<div class="p-3 text-xs text-fg-muted">{t()("storages.empty")}</div>}
      >
        <NoStorages />
      </Show>
    }
  >
    <div class="space-y-1 p-2">
      <For each={storages()}>
        {(s) => {
          const used = () => fraction(s.totalCapacity - s.freeSpace, s.totalCapacity);
          return (
            <button
              class="flex w-full flex-col gap-1 rounded px-2 py-1.5 text-left hover:bg-bg-muted"
              classList={{ "bg-bg-muted": storageId() === s.id }}
              onClick={() => void selectStorage(s.id)}
            >
              <span class="flex w-full items-center gap-1.5">
                <HardDrive size={13} class="shrink-0 text-fg-muted" />
                <span class="min-w-0 flex-1 truncate text-xs font-medium">{s.description}</span>
                <Show when={!s.isWritable}>
                  <Lock size={11} class="shrink-0 text-warn" />
                </Show>
              </span>
              <span class="h-1 w-full overflow-hidden rounded-full bg-bg-subtle">
                <span
                  class="block h-full rounded-full bg-accent"
                  style={{ width: `${used() * 100}%` }}
                />
              </span>
              <span class="text-xs text-fg-muted">
                {t()("storages.free_of", {
                  free: formatBytes(s.freeSpace),
                  total: formatBytes(s.totalCapacity),
                })}
                <Show when={!s.isWritable}> · {t()("storages.read_only")}</Show>
              </span>
            </button>
          );
        }}
      </For>
    </div>
  </Show>
);

export default StorageList;
