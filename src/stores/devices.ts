import { createSignal } from "solid-js";
import { api, asAdxError } from "@/ipc/client";
import type { AdxError, DeviceDto } from "@/ipc/types";

/**
 * Device list state. A plain store rather than `createResource` because the
 * list has two independent triggers — the user's Refresh button and (from T02)
 * hotplug events — and a resource's refetch semantics fit neither cleanly.
 */

const [devices, setDevices] = createSignal<DeviceDto[]>([]);
const [loading, setLoading] = createSignal(false);
const [error, setError] = createSignal<AdxError | null>(null);
const [selected, setSelected] = createSignal<string | null>(null);

export { devices, loading, error, selected };

export function selectDevice(serial: string | null): void {
  setSelected(serial);
}

export async function refreshDevices(): Promise<void> {
  setLoading(true);
  // Clearing the error here, not only on success, is deliberate. On Pane a red
  // banner outlived the condition that caused it — the device came back but the
  // stale message stayed pinned above a list that had since found it, which
  // reads as a live error. Refresh means "re-ask reality", so the previous
  // answer goes first.
  setError(null);
  try {
    const list = await api.devices.list();
    setDevices(list);

    // A selected device that is no longer attached must not stay selected:
    // every downstream panel keys off it, and pointing them at a device that
    // is gone is how a UI ends up showing a tree it can never refresh.
    const current = selected();
    if (current && !list.some((d) => d.serial === current)) {
      setSelected(null);
    }
  } catch (e) {
    setError(asAdxError(e));
    setDevices([]);
    setSelected(null);
  } finally {
    setLoading(false);
  }
}
