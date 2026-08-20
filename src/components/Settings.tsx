import { type Component, For, Show } from "solid-js";
import { Languages, Moon, Sun, SunMoon } from "lucide-solid";
import { LOCALES, locale, setLocale, t } from "@/i18n";
import { setTheme, theme, THEMES } from "@/stores/theme";
import { Button, Modal } from "@/components/Modal";

/**
 * The Settings dialog, opened from the application menu (⌘,).
 *
 * It holds the same two settings as the footer of the left panel rather than
 * new ones. The footer is where they are used — one click to flip the theme —
 * and this is where they are *looked for*, because ⌘, is where every macOS app
 * puts its settings. Two doors into one room; nothing here is a second source
 * of truth, both write the same stores.
 *
 * The theme is a three-way choice here rather than the footer's cycle button.
 * Cycling is right for a one-click control and wrong for a dialog: a dialog is
 * where someone goes to *set* a value, and hunting for "System" by pressing a
 * button three times is not setting it.
 */
const Settings: Component<{ onClose: () => void }> = (props) => (
  <Modal
    title={t()("settings.title")}
    onClose={props.onClose}
    footer={
      <Button variant="primary" onClick={props.onClose}>
        {t()("dialog.close")}
      </Button>
    }
  >
    <div class="space-y-4">
      <section class="space-y-1.5">
        <div class="flex items-center gap-1.5 text-fg-muted">
          <Show when={theme() !== "system"} fallback={<SunMoon size={13} class="shrink-0" />}>
            <Show when={theme() === "dark"} fallback={<Sun size={13} class="shrink-0" />}>
              <Moon size={13} class="shrink-0" />
            </Show>
          </Show>
          {t()("settings.theme")}
        </div>
        <div class="flex gap-1">
          <For each={THEMES}>
            {(value) => (
              <button
                class="flex-1 rounded border px-2 py-1 text-xs"
                classList={{
                  "border-accent bg-accent/15 text-fg font-medium": theme() === value,
                  "border-border text-fg-muted hover:bg-bg-muted": theme() !== value,
                }}
                onClick={() => setTheme(value)}
              >
                {t()(`settings.theme_${value}`)}
              </button>
            )}
          </For>
        </div>
      </section>

      <section class="space-y-1.5">
        <div class="flex items-center gap-1.5 text-fg-muted">
          <Languages size={13} class="shrink-0" />
          {t()("settings.language")}
        </div>
        <div class="flex gap-1">
          <For each={LOCALES}>
            {(l) => (
              <button
                class="flex-1 rounded border px-2 py-1 text-xs"
                classList={{
                  "border-accent bg-accent/15 text-fg font-medium": locale() === l.code,
                  "border-border text-fg-muted hover:bg-bg-muted": locale() !== l.code,
                }}
                onClick={() => setLocale(l.code)}
              >
                {l.label}
              </button>
            )}
          </For>
        </div>
      </section>
    </div>
  </Modal>
);

export default Settings;
