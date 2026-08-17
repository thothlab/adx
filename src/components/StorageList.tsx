import { type Component, For, Show } from "solid-js";
import { HardDrive, Lock } from "lucide-solid";
import { t } from "@/i18n";
import { formatBytes, fraction } from "@/lib/format";
import { selectStorage, storageId, storages } from "@/stores/browser";

/**
 * Storage volumes on the open device.
 *
 * Phones ship with two of these more often than not — internal memory and an
 * SD card — and the measured device had exactly that. They are not
 * interchangeable: the card may be nearly empty while internal memory is full,
 * and a file written to the wrong one is a file the user cannot find. So the
 * choice is explicit, with the free space next to it.
 */
const StorageList: Component = () => (
  <Show
    when={storages().length}
    fallback={<div class="p-3 text-xs text-fg-muted">{t()("storages.empty")}</div>}
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
