import { type Component, For, Show } from "solid-js";
import { Smartphone } from "lucide-solid";
import type { AdxError, DeviceDto } from "@/ipc/types";
import { t } from "@/i18n";
import ErrorBanner from "@/components/ErrorBanner";

/**
 * The device list and its empty states. Three of them are genuinely different
 * situations and must not collapse into one message:
 *
 *  - nothing plugged in            → "connect a cable"
 *  - plugged in, charging-only     → "pick file transfer mode on the phone"
 *  - plugged in, held by a process → name the process, offer to release it
 *
 * Android File Transfer showing one vague message for all three is a large
 * part of why it reads as unreliable.
 */

const DeviceRow: Component<{
  device: DeviceDto;
  selected: boolean;
  onSelect: () => void;
}> = (props) => (
  <button
    class="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-bg-muted"
    classList={{ "bg-bg-muted": props.selected }}
    onClick={() => props.onSelect()}
    disabled={props.device.state !== "ready"}
  >
    <Smartphone size={14} class="mt-0.5 shrink-0 text-fg-muted" />
    <span class="min-w-0">
      <span class="block truncate text-xs font-medium">
        {[props.device.manufacturer, props.device.model].filter(Boolean).join(" ") ||
          props.device.serial}
      </span>
      <Show
        when={props.device.state === "ready"}
        fallback={
          <>
            <span class="block text-xs text-warn">{t()("devices.charging_only")}</span>
            {/* The persistent setting, not just the one-off swipe. A user who
                plugs the same phone in daily should have to do this once, and
                nothing in the notification shade tells them it exists. */}
            <span class="mt-0.5 block text-xs text-fg-muted">
              {t()("devices.charging_only_hint")}
            </span>
          </>
        }
      >
        <span class="block truncate font-mono text-xs text-fg-muted">
          {props.device.serial}
        </span>
      </Show>
    </span>
  </button>
);

const DeviceList: Component<{
  devices: DeviceDto[] | undefined;
  loading: boolean;
  error: AdxError | null;
  selected: string | null;
  onSelect: (serial: string) => void;
}> = (props) => (
  <div class="space-y-2 p-2">
    {/* No dismiss button: Refresh and every hotplug event clear this one, so a
        banner the user hid would come back on the next USB event anyway. */}
    <Show when={props.error}>{(err) => <ErrorBanner error={err()} />}</Show>

    <Show
      when={props.devices?.length}
      fallback={
        <Show when={!props.loading} fallback={<div class="px-1 text-xs text-fg-muted">…</div>}>
          <div class="space-y-1 px-1">
            <div class="text-xs font-medium text-fg-subtle">{t()("devices.empty_title")}</div>
            <div class="text-xs text-fg-muted">{t()("devices.empty_hint")}</div>
          </div>
        </Show>
      }
    >
      <For each={props.devices}>
        {(d) => (
          <DeviceRow
            device={d}
            selected={props.selected === d.serial}
            onSelect={() => props.onSelect(d.serial)}
          />
        )}
      </For>
    </Show>
  </div>
);

export default DeviceList;
