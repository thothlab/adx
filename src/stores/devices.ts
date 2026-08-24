import { createSignal } from "solid-js";
import { api, asAdxError, onDevicesChanged } from "@/ipc/client";
import type { AdxError, DeviceDto } from "@/ipc/types";

/**
 * Device list state. A plain store rather than `createResource` because the
 * list has three independent triggers — startup, the Refresh button, and USB
 * hotplug events — and a resource's refetch semantics fit none of them cleanly.
 *
 * The Refresh button still exists, but it is now a fallback rather than the
 * mechanism: `watchDevices()` pushes a new list whenever USB changes, including
 * the case the button was really there for — the user picking file-transfer
 * mode on the phone half a minute after plugging the cable in.
 */

const [devices, setDevices] = createSignal<DeviceDto[]>([]);
const [loading, setLoading] = createSignal(false);
const [error, setError] = createSignal<AdxError | null>(null);
const [selected, setSelected] = createSignal<string | null>(null);

export { devices, loading, error, selected };

export function selectDevice(serial: string | null): void {
  setSelected(serial);
}

/** The device the user is working with, or `null`. */
export function selectedDevice(): DeviceDto | undefined {
  const serial = selected();
  return serial ? devices().find((d) => d.serial === serial) : undefined;
}

/**
 * Replace the list, keeping the selection if the device is still there.
 *
 * Keeping it is the whole point: a hotplug event fires when *any* USB device
 * changes, including ones ADX does not care about. Resetting the selection on
 * every list would close the open session and throw away the user's place in
 * the folder tree because someone plugged in a mouse.
 */
function applyList(list: DeviceDto[]): void {
  setDevices(list);
  setError(null);

  // The selection is dropped both when the device is gone and when it is still
  // attached but no longer browsable — a replug brings the terminal back on the
  // bus in USB-debugging mode, with no MTP function on it. Keeping it selected
  // there means holding a session to a device that cannot answer, and — because
  // opening follows the *selection* — nothing re-opens when the device becomes
  // browsable again a moment later. Dropping it puts the auto-pick rule below
  // back in charge, which is what makes "плюс режим передачи файлов" recover on
  // its own.
  const current = selected();
  const attached = list.find((d) => d.serial === current);
  if (current && (!attached || attached.state !== "ready")) {
    setSelected(null);
  }

  // With exactly one usable device and nothing chosen, choose it. The first
  // question this app got from its first user was "what do I do next" while
  // looking at a list holding their only phone.
  if (selected() === null) {
    const ready = list.filter((d) => d.state === "ready");
    if (ready.length === 1) setSelected(ready[0].serial);
  }
}

/**
 * Bumped by every Refresh. The shell watches it alongside the selection, so
 * pressing the button re-opens the session even when the list came back
 * identical — which is exactly the case the button is pressed in: same device,
 * same serial, same port, but the session behind it died with the replug.
 */
const [reconnects, setReconnects] = createSignal(0);

export { reconnects };

export async function refreshDevices(): Promise<void> {
  setLoading(true);
  // Clearing the error here, not only on success, is deliberate. On Pane a red
  // banner outlived the condition that caused it — the device came back but the
  // stale message stayed pinned above a list that had since found it, which
  // reads as a live error. Refresh means "re-ask reality", so the previous
  // answer goes first.
  setError(null);
  try {
    applyList(await api.devices.list());
  } catch (e) {
    setError(asAdxError(e));
    setDevices([]);
    setSelected(null);
  } finally {
    setLoading(false);
  }
}

/**
 * What the Refresh button does: re-ask the bus *and* re-open the session.
 *
 * Kept apart from `refreshDevices` because the startup enumeration calls that
 * one, and bumping the counter there would open every device twice on launch.
 * The button means "re-ask reality", and after a replug the stale thing is not
 * the list — the list comes back identical — but the session behind it.
 */
export async function reconnectDevices(): Promise<void> {
  await refreshDevices();
  setReconnects(reconnects() + 1);
}

/**
 * Subscribe to hotplug. Returns the unlisten function; the caller owns it.
 *
 * The backend sends the full list rather than a delta, so there is no
 * enumerate-on-event round trip and no window where the UI's idea of what is
 * attached disagrees with the backend's.
 */
export function watchDevices(): Promise<() => void> {
  return onDevicesChanged(applyList);
}

/** Exposed for tests: the selection rules are the part worth pinning. */
export const __test = { applyList, setSelected, setDevices };
