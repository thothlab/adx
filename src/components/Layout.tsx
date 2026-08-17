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
import StorageList from "@/components/StorageList";
import { devices, error, loading, refreshDevices, selectDevice, selected, watchDevices } from "@/stores/devices";
import { canWrite, closeDevice, openDevice } from "@/stores/browser";
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

const Layout: Component = () => {
  const [dragging, setDragging] = createSignal(false);

  onMount(() => {
    // One enumeration at startup for devices already attached, then hotplug
    // takes over. The Refresh button stays as a fallback for the case where the
    // OS refuses to hand out notifications.
    void refreshDevices();

    const subscriptions = [watchDevices(), watchUploads()];
    onCleanup(() => {
      for (const pending of subscriptions) void pending.then((un) => un());
    });

    // Native file drops from Finder. `dragDropEnabled: true` in
    // `tauri.conf.json` is what routes them here instead of to the webview's
    // own HTML5 handlers — the inverse of Pane's setting, because there the
    // internal drag was the important one and here the external drop is.
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over" || event.payload.type === "enter") {
          setDragging(true);
        } else if (event.payload.type === "drop") {
          setDragging(false);
          if (canWrite()) void upload(event.payload.paths);
        } else {
          setDragging(false);
        }
      })
      .then((un) => onCleanup(un));
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
    <div class="flex h-full flex-col bg-bg text-fg">
      <header class="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <div class="flex items-baseline gap-2">
          <span class="text-sm font-semibold tracking-tight">{t()("app.name")}</span>
          <span class="text-xs text-fg-muted">{t()("app.tagline")}</span>
        </div>

        <div class="flex items-center gap-1">
          <button
            class="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-bg-muted disabled:opacity-50"
            title={t()("devices.refresh")}
            disabled={loading()}
            onClick={() => void refreshDevices()}
          >
            <RefreshCw size={12} class={loading() ? "animate-spin" : undefined} />{" "}
            {t()("devices.refresh")}
          </button>

          <button
            class="inline-flex items-center rounded border border-border px-2 py-1 text-xs hover:bg-bg-muted"
            title={t()("settings.theme")}
            onClick={() => cycleTheme()}
          >
            <Show when={theme() !== "system"} fallback={<SunMoon size={14} />}>
              <Show when={theme() === "dark"} fallback={<Sun size={14} />}>
                <Moon size={14} />
              </Show>
            </Show>
          </button>

          <div class="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs">
            <Languages size={12} />
            <For each={LOCALES}>
              {(l) => (
                <button
                  class="rounded px-1 hover:bg-bg-muted"
                  classList={{ "text-accent font-medium": locale() === l.code }}
                  onClick={() => setLocale(l.code)}
                >
                  {l.code.toUpperCase()}
                </button>
              )}
            </For>
          </div>
        </div>
      </header>

      <div class="relative grid min-h-0 flex-1 grid-cols-[15rem_15rem_1fr]">
        <div class="flex min-h-0 flex-col border-r border-border">
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
        </div>

        <Panel title={t()("tree.title")} class="border-r border-border">
          <FolderTree />
        </Panel>

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
              {canWrite() ? t()("listing.drop_here") : t()("listing.drop_blocked")}
            </span>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default Layout;
