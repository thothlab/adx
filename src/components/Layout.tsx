import {
  type Component,
  createEffect,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  HardDrive,
  Languages,
  ListTodo,
  Moon,
  RefreshCw,
  Smartphone,
  Sun,
  SunMoon,
} from "lucide-solid";
import { LOCALES, locale, setLocale, t } from "@/i18n";
import { cycleTheme, theme } from "@/stores/theme";
import DeviceList from "@/components/DeviceList";
import FolderTree from "@/components/FolderTree";
import Jobs from "@/components/Jobs";
import Listing from "@/components/Listing";
import Splitter from "@/components/Splitter";
import StorageList from "@/components/StorageList";
import { devices, error, loading, refreshDevices, selectDevice, selected, watchDevices } from "@/stores/devices";
import { canWrite, closeDevice, openDevice, refreshStorages } from "@/stores/browser";
import {
  resetSidebarWidth,
  resetTreeWidth,
  resizing,
  setSidebarWidth,
  setTreeWidth,
  sidebarWidth,
  treeWidth,
} from "@/stores/panes";
import { transferBusy, watchDownloads } from "@/stores/download";
import { upload, watchUploads } from "@/stores/transfer";

/**
 * The four regions of the app-shell requirement — devices + storages, folder
 * tree, listing, operations — all visible at once, no mode switching.
 */

const Panel: Component<{
  title: string;
  icon?: JSX.Element;
  class?: string;
  children: JSX.Element;
}> = (props) => (
  <section class={`flex min-h-0 flex-col ${props.class ?? ""}`}>
    <header class="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2 text-xs font-medium text-fg-subtle">
      <Show when={props.icon}>{props.icon}</Show>
      {props.title}
    </header>
    <div class="min-h-0 flex-1 overflow-auto">{props.children}</div>
  </section>
);

/**
 * Theme and language, at the foot of the sidebar.
 *
 * Both are set once and then forgotten, so they sit where a settings row
 * belongs — pinned to the bottom of the panel, below the content that changes —
 * rather than in the header, which is reserved for what acts on the device.
 *
 * `shrink-0` and no scroll container: this is a fixed two-row strip. Inside the
 * scrolling panel above it, a long device list would push it out of reach.
 */
const SettingsFooter: Component = () => {
  const themeName = () =>
    t()(
      theme() === "dark"
        ? "settings.theme_dark"
        : theme() === "light"
          ? "settings.theme_light"
          : "settings.theme_system",
    );

  return (
    <div class="shrink-0 border-t border-border py-1">
      {/* One button for the whole row, not an icon with a label beside it: the
          row is the target, which is what makes a 13px icon clickable. */}
      <button
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-bg-muted"
        title={t()("settings.theme")}
        onClick={() => cycleTheme()}
      >
        <Show when={theme() !== "system"} fallback={<SunMoon size={13} class="shrink-0 text-fg-muted" />}>
          <Show when={theme() === "dark"} fallback={<Sun size={13} class="shrink-0 text-fg-muted" />}>
            <Moon size={13} class="shrink-0 text-fg-muted" />
          </Show>
        </Show>
        <span class="min-w-0 flex-1 truncate">{t()("settings.theme")}</span>
        <span class="shrink-0 text-fg-muted">{themeName()}</span>
      </button>

      <div class="flex w-full items-center gap-2 px-3 py-1.5 text-xs">
        <Languages size={13} class="shrink-0 text-fg-muted" />
        <span class="min-w-0 flex-1 truncate">{t()("settings.language")}</span>
        <span class="flex shrink-0 items-center gap-1">
          <For each={LOCALES}>
            {(l) => (
              <button
                class="rounded px-1 hover:bg-bg-muted"
                classList={{
                  "text-accent font-medium": locale() === l.code,
                  "text-fg-muted": locale() !== l.code,
                }}
                onClick={() => setLocale(l.code)}
              >
                {l.code.toUpperCase()}
              </button>
            )}
          </For>
        </span>
      </div>
    </div>
  );
};

const Layout: Component = () => {
  const [dragging, setDragging] = createSignal(false);

  onMount(() => {
    // One enumeration at startup for devices already attached, then hotplug
    // takes over. The Refresh button stays as a fallback for the case where the
    // OS refuses to hand out notifications.
    void refreshDevices();

    // Native file drops from Finder. `dragDropEnabled: true` in
    // `tauri.conf.json` is what routes them here instead of to the webview's
    // own HTML5 handlers — the inverse of Pane's setting, because there the
    // internal drag was the important one and here the external drop is.
    const dragDrop = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over" || event.payload.type === "enter") {
        setDragging(true);
      } else if (event.payload.type === "drop") {
        setDragging(false);
        // Same rule as the toolbar: one transfer at a time, because the device
        // has one session. A drop accepted during a running copy would sit on
        // the lock with no visible reason.
        if (canWrite() && !transferBusy()) void upload(event.payload.paths);
      } else {
        setDragging(false);
      }
    });

    // Every unlisten registered here, synchronously. `promise.then((un) =>
    // onCleanup(un))` looks equivalent and is not: by the time the callback
    // runs there is no reactive owner, so `onCleanup` silently does nothing and
    // the listener survives every hot reload. Stacked drop listeners mean one
    // drag from Finder starting the same upload several times.
    const subscriptions = [watchDevices(), watchUploads(), watchDownloads(), dragDrop];
    onCleanup(() => {
      for (const pending of subscriptions) void pending.then((un) => un());
    });
  });

  // Opening and closing follow the selection, and only the selection. `on(...,
  // { defer: false })` with an explicit dependency keeps this from re-running
  // when the device list refreshes for unrelated reasons — re-opening a working
  // session is a visible stall and a window in which a transfer would fail.
  createEffect(
    on(selected, (serial) => {
      if (serial) void openDevice(serial);
      else void closeDevice();
    }),
  );

  return (
    // `select-none` on the whole shell, not just on the listing: this is a file
    // manager, and every drag in it is meant to move a divider or a file. A
    // drag that misses the divider by two pixels otherwise paints the browser's
    // blue text selection across the panel labels — the same artefact that made
    // multi-row selection unreadable before (commit 7987acb), in a new place.
    // Content that is meant to be selected opts back in with `select-text`.
    <div class="flex h-full select-none flex-col bg-bg text-fg">
      <header class="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <div class="flex items-baseline gap-2">
          <span class="text-sm font-semibold tracking-tight">{t()("app.name")}</span>
          <span class="text-xs text-fg-muted">{t()("app.tagline")}</span>
        </div>

        {/* Refresh stays in the header: it acts on the device list, which is
            what the window is about. Theme and language moved to the foot of
            the sidebar — they are settings, touched once and then never, and a
            control that competes for the top-right corner with the one action
            the user actually repeats has the priorities backwards. */}
        <button
          class="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-bg-muted disabled:opacity-50"
          title={t()("devices.refresh")}
          disabled={loading()}
          // Re-asks the open device too, not only the USB bus. The case that
          // needs it: a locked phone opens a session and reports zero
          // storages, and unlocking the screen changes nothing on the bus — so
          // re-enumerating alone comes back with the identical list and the
          // pane stays empty. This is the button a user presses first when
          // something looks stuck, and it has to be the one that helps.
          onClick={() => {
            void refreshDevices();
            void refreshStorages();
          }}
        >
          <RefreshCw size={12} class={loading() ? "animate-spin" : undefined} />{" "}
          {t()("devices.refresh")}
        </button>
      </header>

      {/* Columns are px values from the pane store rather than Tailwind classes,
          because a dragged width is a number that changes 60 times a second —
          and `select-none` is on for the duration of a drag so the pointer
          crossing the listing does not paint a text selection over it. */}
      <div
        class="relative grid min-h-0 flex-1"
        classList={{ "select-none": resizing() }}
        style={{ "grid-template-columns": `${sidebarWidth()}px 1px ${treeWidth()}px 1px 1fr` }}
      >
        <div class="flex min-h-0 flex-col">
          <Panel
            title={t()("devices.title")}
            icon={<Smartphone size={13} />}
            class="flex-1 border-b border-border"
          >
            <DeviceList
              devices={devices()}
              loading={loading()}
              error={error()}
              selected={selected()}
              onSelect={selectDevice}
            />
          </Panel>
          <Panel title={t()("storages.title")} icon={<HardDrive size={13} />} class="flex-1">
            <StorageList />
          </Panel>

          <SettingsFooter />
        </div>

        <Splitter
          width={sidebarWidth()}
          onResize={setSidebarWidth}
          onReset={resetSidebarWidth}
          label={t()("devices.title")}
        />

        <Panel title={t()("tree.title")}>
          <FolderTree />
        </Panel>

        <Splitter
          width={treeWidth()}
          onResize={setTreeWidth}
          onReset={resetTreeWidth}
          label={t()("tree.title")}
        />

        <div class="flex min-h-0 flex-col">
          <section class="min-h-0 flex-1">
            <Listing />
          </section>
          <Panel
            title={t()("jobs.title")}
            icon={<ListTodo size={13} />}
            class="h-32 shrink-0 border-t border-border"
          >
            <Jobs />
          </Panel>
        </div>

        <Show when={dragging()}>
          <div class="pointer-events-none absolute inset-0 z-40 flex items-center justify-center border-2 border-dashed border-accent bg-accent/10">
            <span class="rounded bg-bg px-3 py-1.5 text-xs font-medium shadow">
              <Show when={!transferBusy()} fallback={t()("listing.drop_busy")}>
                {canWrite() ? t()("listing.drop_here") : t()("listing.drop_blocked")}
              </Show>
            </span>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default Layout;
