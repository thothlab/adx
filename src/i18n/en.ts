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
  },
  listing: {
    title: "Files",
    empty: "Select a folder",
    empty_folder: "This folder is empty",
    name: "Name",
    size: "Size",
    modified: "Modified",
    size_unknown: "unknown",
  },
  jobs: {
    title: "Operations",
    empty: "No operations running",
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
