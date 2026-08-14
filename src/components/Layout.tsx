import { type Component, For, type JSX, Show } from "solid-js";
import { HardDrive, Languages, ListTodo, Moon, RefreshCw, Smartphone, Sun, SunMoon } from "lucide-solid";
import { LOCALES, locale, setLocale, t } from "@/i18n";
import { cycleTheme, theme } from "@/stores/theme";

/**
 * The four regions of the app-shell requirement — devices + storages, folder
 * tree, listing, operations — all visible at once, no mode switching. T00
 * renders them empty; T01…T07 fill them in one at a time.
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

const Empty: Component<{ text: string }> = (props) => (
  <div class="p-3 text-xs text-fg-muted">{props.text}</div>
);

const Layout: Component = () => (
  <div class="flex h-full flex-col bg-bg text-fg">
    <header class="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
      <div class="flex items-baseline gap-2">
        <span class="text-sm font-semibold tracking-tight">{t()("app.name")}</span>
        <span class="text-xs text-fg-muted">{t()("app.tagline")}</span>
      </div>

      <div class="flex items-center gap-1">
        <button
          class="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-bg-muted"
          title={t()("devices.refresh")}
        >
          <RefreshCw size={12} /> {t()("devices.refresh")}
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

    <div class="grid min-h-0 flex-1 grid-cols-[16rem_16rem_1fr]">
      <div class="flex min-h-0 flex-col border-r border-border">
        <Panel
          title={t()("devices.title")}
          icon={<Smartphone size={13} />}
          class="flex-1 border-b border-border"
        >
          <div class="space-y-1 p-3">
            <div class="text-xs font-medium text-fg-subtle">{t()("devices.empty_title")}</div>
            <div class="text-xs text-fg-muted">{t()("devices.empty_hint")}</div>
          </div>
        </Panel>
        <Panel title={t()("storages.title")} icon={<HardDrive size={13} />} class="flex-1">
          <Empty text={t()("storages.empty")} />
        </Panel>
      </div>

      <Panel title={t()("tree.title")} class="border-r border-border">
        <Empty text={t()("tree.empty")} />
      </Panel>

      <div class="flex min-h-0 flex-col">
        <Panel title={t()("listing.title")} class="flex-1">
          <Empty text={t()("listing.empty")} />
        </Panel>
        <Panel
          title={t()("jobs.title")}
          icon={<ListTodo size={13} />}
          class="h-32 shrink-0 border-t border-border"
        >
          <Empty text={t()("jobs.empty")} />
        </Panel>
      </div>
    </div>
  </div>
);

export default Layout;
