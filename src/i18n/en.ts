/**
 * English dictionary — the source of truth for the key set. `ru.ts` is typed
 * against `Dict`, so a key added here without a Russian translation is a
 * compile error rather than a silently untranslated string.
 */
const en = {
  app: {
    name: "ADX",
    tagline: "Android Device eXplorer",
  },
  devices: {
    title: "Devices",
    refresh: "Refresh",
    empty_title: "No device connected",
    empty_hint:
      "Connect an Android device with a USB cable and pick file transfer mode on the phone.",
    charging_only: "Charging only — pick file transfer mode on the phone",
    charging_only_hint:
      "To stop repeating it: Developer options → Default USB configuration → File Transfer.",
  },
  errors: {
    no_device: "No device found",
    occupied: "The device is held by another process",
    unauthorized: "The device does not expose files",
    permission_denied: "No permission to access the device",
    busy: "The device is busy",
    disconnected: "The device was disconnected",
    device_reset: "The device was reset — reconnecting",
    stale_handle: "The list is out of date — refreshing",
    timeout: "The device did not respond in time",
    not_found: "Not found",
    not_writable: "Writing is not allowed here",
    unsupported: "The device does not support this operation",
    name_too_long: "The name is too long",
    name_invalid: "The name contains invalid characters",
    name_taken: "That name is already taken in this folder",
    not_enough_space: "Not enough free space on the device",
    cancelled: "Cancelled",
    io: "Device communication error",
    protocol: "Unexpected device response",
  },
  storages: {
    title: "Storage",
    empty: "Select a device",
    free_of: "{{free}} free of {{total}}",
    read_only: "Read-only",
  },
  tree: {
    title: "Folders",
    empty: "Select a storage",
    root: "Storage",
  },
  listing: {
    title: "Files",
    empty: "Select a folder",
    empty_folder: "This folder is empty",
    name: "Name",
    size: "Size",
    modified: "Modified",
    size_unknown: "unknown",
    upload_files: "Add files",
    upload_folder: "Add folder",
    new_folder: "New folder",
    rename: "Rename",
    delete: "Delete",
    reload: "Reload",
    drop_hint: "Drag files or folders here from Finder.",
    drop_here: "Drop to copy to the device",
    drop_blocked: "Open a writable folder on the device first",
  },
  jobs: {
    title: "Operations",
    empty: "No operations running",
    preparing: "Preparing…",
    cancel: "Stop",
    done: "Copied {{files}} file(s), {{bytes}}",
    folders: "{{count}} folder(s) created",
    replaced: "{{count}} replaced",
    skipped: "{{count}} skipped",
    cancelled: "Stopped after {{files}} file(s), {{bytes}}",
  },
  dialog: {
    cancel: "Cancel",
    create: "Create",
    rename: "Rename",
    name_label: "Name",
    new_folder_title: "New folder",
    rename_title: "Rename",
    delete_title: "Delete from the device?",
    delete_body: "{{count}} item(s) will be deleted. Folders go with everything inside them.",
    conflict_title: "Already on the device",
    conflict_body: "{{count}} name(s) already exist in this folder. Nothing has been written yet.",
    conflict_replace: "Replace",
    conflict_skip: "Skip these",
  },
  settings: {
    theme: "Theme",
    theme_light: "Light",
    theme_dark: "Dark",
    theme_system: "System",
    language: "Language",
  },
};

export type Dict = typeof en;
export default en;
