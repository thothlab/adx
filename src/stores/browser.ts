import { createSignal } from "solid-js";
import { api, asAdxError } from "@/ipc/client";
import type { AdxError, EntryDto, OpenedDeviceDto, StorageDto } from "@/ipc/types";

/**
 * Browsing state: the open device, its storages, where the user is, and what
 * is in that folder.
 *
 * One session stays open on the backend for as long as a device is selected,
 * so everything here is a read against an already-open device rather than a
 * connect-read-disconnect cycle. That is the difference between a folder that
 * opens in 20 ms and one that opens in a second and occasionally fails.
 */

/** A step in the path. `handle === null` is the storage root. */
export interface Crumb {
  handle: string | null;
  name: string;
}

const [device, setDevice] = createSignal<OpenedDeviceDto | null>(null);
const [storages, setStorages] = createSignal<StorageDto[]>([]);
const [storageId, setStorageId] = createSignal<string | null>(null);
const [crumbs, setCrumbs] = createSignal<Crumb[]>([]);
const [entries, setEntries] = createSignal<EntryDto[]>([]);
const [busy, setBusy] = createSignal(false);
const [browseError, setBrowseError] = createSignal<AdxError | null>(null);

/**
 * Bumped whenever something on the device changed. The folder tree watches it
 * and re-reads the branches it has expanded — without it a folder created or
 * deleted in the listing would stay visible in the tree until the user
 * collapsed and re-expanded its parent.
 */
const [treeVersion, bumpTreeVersion] = createSignal(0);

export { browseError, busy, crumbs, device, entries, storageId, storages, treeVersion };

export function currentStorage(): StorageDto | undefined {
  const id = storageId();
  return id ? storages().find((s) => s.id === id) : undefined;
}

/** Handle of the folder being shown, or `null` for the storage root. */
export function currentFolder(): string | null {
  const path = crumbs();
  return path.length ? path[path.length - 1].handle : null;
}

export function canWrite(): boolean {
  return (device()?.canWrite ?? false) && (currentStorage()?.isWritable ?? false);
}

function clear(): void {
  setDevice(null);
  setStorages([]);
  setStorageId(null);
  setCrumbs([]);
  setEntries([]);
}

/** Open a device and land the user in the first storage's root. */
export async function openDevice(serial: string): Promise<void> {
  setBusy(true);
  setBrowseError(null);
  try {
    const opened = await api.devices.open(serial);
    setDevice(opened);
    setStorages(opened.storages);

    // Landing somewhere is not a convenience, it is the answer to "what do I do
    // now": an app that opens a device and then shows four empty panels has
    // told the user nothing.
    const first = opened.storages[0];
    if (first) {
      await selectStorage(first.id);
    } else {
      setStorageId(null);
      setCrumbs([]);
      setEntries([]);
    }
  } catch (e) {
    setBrowseError(asAdxError(e));
    clear();
  } finally {
    setBusy(false);
  }
}

export async function closeDevice(): Promise<void> {
  clear();
  setBrowseError(null);
  try {
    await api.devices.close();
  } catch {
    // A device that was yanked out cannot acknowledge a close, and saying so
    // would be an error message about something the user already did on
    // purpose.
  }
}

export async function selectStorage(id: string): Promise<void> {
  setStorageId(id);
  setCrumbs([]);
  await loadEntries();
}

export async function enterFolder(handle: string, name: string): Promise<void> {
  setCrumbs([...crumbs(), { handle, name }]);
  await loadEntries();
}

/** Jump to a crumb. `depth === 0` is the storage root. */
export async function goToDepth(depth: number): Promise<void> {
  setCrumbs(crumbs().slice(0, depth));
  await loadEntries();
}

/** Open a folder by its full path, used by the tree. */
export async function goToPath(path: Crumb[]): Promise<void> {
  setCrumbs(path);
  await loadEntries();
}

export async function loadEntries(): Promise<void> {
  const id = storageId();
  if (!id) {
    setEntries([]);
    return;
  }
  setBusy(true);
  setBrowseError(null);
  try {
    setEntries(await api.folders.list(id, currentFolder()));
  } catch (e) {
    setBrowseError(asAdxError(e));
    setEntries([]);
  } finally {
    setBusy(false);
  }
}

/** Re-read the current folder, the tree and the free-space figures. */
export async function reloadAll(): Promise<void> {
  await loadEntries();
  bumpTreeVersion(treeVersion() + 1);
  try {
    setStorages(await api.storages.refresh());
  } catch {
    // Free space is decoration next to the listing; a failure to refresh it
    // must not turn a successful transfer into a visible error.
  }
}

export async function createFolder(name: string): Promise<void> {
  const id = storageId();
  if (!id) return;
  setBrowseError(null);
  try {
    await api.folders.create(id, currentFolder(), name);
    await reloadAll();
  } catch (e) {
    setBrowseError(asAdxError(e));
  }
}

export async function removeEntries(handles: string[]): Promise<void> {
  const id = storageId();
  if (!id) return;
  setBusy(true);
  setBrowseError(null);
  try {
    // Sequential on purpose: the device takes one transaction at a time, and
    // firing these in parallel only queues them behind the same mutex while
    // making the first failure harder to attribute.
    for (const handle of handles) {
      await api.entries.remove(id, handle);
    }
  } catch (e) {
    setBrowseError(asAdxError(e));
  } finally {
    setBusy(false);
    await reloadAll();
  }
}

export async function renameEntry(handle: string, name: string): Promise<void> {
  const id = storageId();
  if (!id) return;
  setBrowseError(null);
  try {
    await api.entries.rename(id, handle, name);
    await reloadAll();
  } catch (e) {
    setBrowseError(asAdxError(e));
  }
}
