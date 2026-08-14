import { type Component, For, Show } from "solid-js";
import { AlertCircle, Smartphone } from "lucide-solid";
import type { AdxError, DeviceDto } from "@/ipc/types";
import { t } from "@/i18n";

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
          <span class="block text-xs text-warn">{t()("devices.charging_only")}</span>
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
    <Show when={props.error}>
      {(err) => (
        <div class="flex items-start gap-2 rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger">
          <AlertCircle size={13} class="mt-0.5 shrink-0" />
          <div>
            <div class="font-medium">{t()(`errors.${err().kind}`)}</div>
            <Show when={err().holder}>
              {(h) => (
                <div class="mt-0.5 font-mono text-xs opacity-80">
                  {h().name}
                  <Show when={h().pid > 0}> ({h().pid})</Show>
                </div>
              )}
            </Show>
          </div>
        </div>
      )}
    </Show>

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
