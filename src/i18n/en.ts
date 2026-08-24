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
    // Deliberately names the setting without a menu path. Vendor skins rename
    // and move these screens, and on some builds the setting only takes effect
    // with USB debugging on — a wrong path in the app is worse than no hint.
    charging_only_hint:
      "Android can remember the choice: look for a default USB mode setting on the phone and set it once.",
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
    detail: "Technical details",
    dismiss: "Dismiss",
    occupied_hint: "Quit the application holding the device, then press Refresh.",
    space_detail: "Needs {{required}}, {{free}} free.",
    permission_hint:
      "The device is not held by anything — this user account may not open USB devices. Find the phone's vendor id and allow it:",
  },
  storages: {
    title: "Storage",
    empty: "Select a device",
    // The device answered, and its answer was "nothing". Deliberately does not
    // claim the phone is locked — it is the usual cause, not the only one — but
    // names it first, because unlocking the screen is what fixes it nine times
    // out of ten and costs nothing to try.
    none_title: "The device is not showing any storage",
    none_hint:
      "Unlock the phone screen, and confirm file transfer on it if it asks. The phone shows nothing until you do.",
    none_retry: "Ask again",
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
    loading: "Loading…",
    name: "Name",
    size: "Size",
    modified: "Modified",
    size_unknown: "unknown",
    upload_files: "Add files",
    upload_folder: "Add folder",
    download: "Copy to computer",
    download_to: "Choose a folder…",
    download_to_downloads: "Save to Downloads",
    new_folder: "New folder",
    rename: "Rename",
    delete: "Delete",
    reload: "Reload",
    selected: "{{count}} selected",
    drop_hint: "Drag files or folders here from Finder.",
    drop_here: "Drop to copy to the device",
    drop_blocked: "Open a writable folder on the device first",
    drop_busy: "Wait for the running transfer to finish",
  },
  preview: {
    loading: "Reading from the device…",
    unsupported: "There is no preview for this kind of file — copy it to the computer to open it.",
    too_big: "Too large to preview (over {{size}}) — copy it to the computer instead.",
    truncated: "Showing the first {{size}} — the file is longer.",
    no_pdf_viewer: "This system cannot show a PDF here — copy the file to the computer.",
    pdf_hint: "Blank? This system cannot show a PDF here — copy the file to the computer.",
    no_codec: "This system cannot play this file — copy it to the computer.",
    zoom_in: "Zoom in",
    zoom_out: "Zoom out",
    zoom_fit: "Fit",
    zoom_reset: "Back to fit",
    prev: "Previous file",
    next: "Next file",
  },
  jobs: {
    title: "Operations",
    empty: "No operations running",
    preparing: "Preparing…",
    to_device: "To the device",
    to_computer: "To the computer",
    cancel: "Stop",
    done: "Copied {{files}} file(s), {{bytes}}",
    folders: "{{count}} folder(s) created",
    replaced: "{{count}} replaced",
    skipped: "{{count}} skipped",
    cancelled: "Stopped after {{files}} file(s), {{bytes}}",
  },
  dialog: {
    cancel: "Cancel",
    close: "Close",
    create: "Create",
    rename: "Rename",
    name_label: "Name",
    new_folder_title: "New folder",
    rename_title: "Rename",
    delete_title: "Delete from the device?",
    delete_body: "{{count}} item(s) will be deleted. Folders go with everything inside them.",
    conflict_title: "Already on the device",
    conflict_body: "{{count}} name(s) already exist in this folder. Nothing has been written yet.",
    conflict_title_local: "Already on the computer",
    conflict_body_local:
      "{{count}} name(s) already exist in the folder you picked. Nothing has been written yet.",
    conflict_replace: "Replace",
    conflict_skip: "Skip these",
  },
  update: {
    title: "Check for updates",
    checking: "Asking GitHub…",
    current: "You have the newest version.",
    version: "Installed: {{version}}",
    available: "Version {{version}} is available.",
    open_page: "Open the release page",
    unsigned:
      "The builds are unsigned: macOS will ask you to confirm on first launch, and Windows will show SmartScreen.",
  },
  settings: {
    title: "Settings",
    theme: "Theme",
    theme_light: "Light",
    theme_dark: "Dark",
    theme_system: "System",
    language: "Language",
  },
};

export type Dict = typeof en;
export default en;
