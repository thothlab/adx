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

/**
 * Which folder the rows in `entries()` actually describe.
 *
 * Compared against the folder being asked for, so a re-read of the folder
 * already on screen can be told from a move to a different one. The two want
 * opposite treatment: a move must drop the old rows, a refresh must keep them.
 */
const [shownFolder, setShownFolder] = createSignal<string | null>(null);

/**
 * True only while moving to a folder whose contents are not on screen yet.
 *
 * Deliberately narrower than `busy()`. `busy()` also covers re-reading the
 * current folder after a write, and blanking the listing for that would make
 * every rename flash the folder away and back.
 */
const [folderLoading, setFolderLoading] = createSignal(false);

export { folderLoading };

function folderKey(id: string, path: Crumb[]): string {
  return [id, ...path.map((c) => c.handle ?? "")].join("/");
}

/**
 * Sequence number of the newest listing request.
 *
 * Two listings can be in flight at once — clicking through the tree faster than
 * a phone answers is normal, and the whole reason this is being made visible is
 * that folders can be slow. Without this, the *slower* request wins whenever it
 * lands second, and the user is left looking at a folder they navigated away
 * from, with a breadcrumb that says otherwise.
 */
let latestRequest = 0;

export async function loadEntries(): Promise<void> {
  const id = storageId();
  if (!id) {
    setEntries([]);
    setShownFolder(null);
    return;
  }

  const key = folderKey(id, crumbs());
  const moving = key !== shownFolder();
  const mine = ++latestRequest;

  if (moving) {
    // The rows of the folder being left go immediately. They are not merely
    // stale decoration: MTP object handles are unique per device, not per
    // folder, so a click landing on one of them acts on a real object that is
    // simply not the one the user is looking at.
    setEntries([]);
    setShownFolder(null);
    setFolderLoading(true);
  }
  setBusy(true);
  setBrowseError(null);

  try {
    const list = await api.folders.list(id, currentFolder());
    // Superseded while we waited: whatever came back describes a folder the
    // user has already left, and writing it now would undo the newer request.
    if (mine !== latestRequest) return;
    setEntries(list);
    setShownFolder(key);
  } catch (e) {
    if (mine !== latestRequest) return;
    setBrowseError(asAdxError(e));
    setEntries([]);
  } finally {
    // Only the newest request may clear the flags — an older one finishing
    // late would otherwise take the spinner down while its replacement is
    // still running.
    if (mine === latestRequest) {
      setBusy(false);
      setFolderLoading(false);
    }
  }
}

/**
 * Re-ask the open device what storages it has.
 *
 * Separate from `openDevice` because the answer changes without the connection
 * changing: a locked phone opens an MTP session and reports **zero** storages,
 * then reports them the moment the screen is unlocked. Nothing on the USB side
 * moves when that happens, so no hotplug event fires and the device list looks
 * exactly the same — the only way back is to ask again.
 *
 * Lands the user in the first storage, same as opening the device does. Getting
 * storages and still showing an empty pane would be the same dead end one step
 * further along.
 */
export async function refreshStorages(): Promise<void> {
  if (!device()) return;
  setBusy(true);
  setBrowseError(null);
  try {
    const fresh = await api.storages.refresh();
    setStorages(fresh);
    const first = fresh[0];
    if (first && !storageId()) await selectStorage(first.id);
  } catch (e) {
    setBrowseError(asAdxError(e));
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
