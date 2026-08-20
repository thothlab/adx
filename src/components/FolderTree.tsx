import { type Component, createEffect, createSignal, For, Show } from "solid-js";
import { ChevronDown, ChevronRight, Folder, FolderOpen, HardDrive } from "lucide-solid";
import { api } from "@/ipc/client";
import type { EntryDto } from "@/ipc/types";
import { t } from "@/i18n";
import { createDelayed, SPINNER_DELAY_MS } from "@/lib/delayed";
import Spinner from "@/components/Spinner";
import { type Crumb, crumbs, currentStorage, goToPath, storageId, treeVersion } from "@/stores/browser";

/**
 * The folder tree.
 *
 * Children load when a branch is first expanded, not up front. A recursive
 * listing of a phone is thousands of round trips — the measured device answered
 * a single folder in 17-250 ms, so walking it eagerly would cost minutes before
 * the first folder appeared.
 */

const Node: Component<{
  storageId: string;
  /** Full path to this node; `[]` is the storage root. */
  path: Crumb[];
  handle: string | null;
  name: string;
  depth: number;
  icon?: Component<{ size?: number; class?: string }>;
}> = (props) => {
  // Read once, on purpose: a node's depth is fixed by where it sits in the
  // tree, so this is an initial value rather than something to track. The root
  // starts open because a tree whose only visible row is the storage name has
  // shown the user nothing.
  // eslint-disable-next-line solid/reactivity
  const [expanded, setExpanded] = createSignal(props.depth === 0);
  const [children, setChildren] = createSignal<EntryDto[] | null>(null);
  const [loading, setLoading] = createSignal(false);
  /** Only once the branch has kept the user waiting. */
  const slowLoad = createDelayed(loading, SPINNER_DELAY_MS);

  // Re-reads on expand and whenever something changed the device. Without the
  // `treeVersion()` read, a folder created or deleted in the listing would stay
  // in the tree until its parent was collapsed and expanded again.
  createEffect(() => {
    treeVersion();
    if (!expanded()) return;
    setLoading(true);
    void api.folders
      .list(props.storageId, props.handle)
      .then((list) => setChildren(list.filter((e) => e.isFolder)))
      // A branch that cannot be read shows as empty rather than blanking the
      // whole tree: one unreadable folder is not a reason to lose the rest.
      .catch(() => setChildren([]))
      .finally(() => setLoading(false));
  });

  const isCurrent = () => {
    const here = crumbs();
    return (
      here.length === props.path.length &&
      here.every((c, i) => c.handle === props.path[i]?.handle)
    );
  };

  return (
    <div>
      <div
        class="flex items-center gap-0.5 rounded pr-1 hover:bg-bg-muted"
        classList={{ "bg-bg-muted": isCurrent() }}
        style={{ "padding-left": `${props.depth * 12}px` }}
      >
        <button
          class="shrink-0 rounded p-0.5 text-fg-muted hover:text-fg"
          onClick={() => setExpanded(!expanded())}
          title={expanded() ? "−" : "+"}
        >
          <Show when={expanded()} fallback={<ChevronRight size={12} />}>
            <ChevronDown size={12} />
          </Show>
        </button>
        <button
          class="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
          onClick={() => void goToPath(props.path)}
        >
          <Show
            when={props.depth > 0}
            fallback={<HardDrive size={13} class="shrink-0 text-fg-muted" />}
          >
            <Show
              when={expanded()}
              fallback={<Folder size={13} class="shrink-0 text-fg-muted" />}
            >
              <FolderOpen size={13} class="shrink-0 text-accent" />
            </Show>
          </Show>
          <span class="truncate text-xs">{props.name}</span>
        </button>
      </div>

      <Show when={expanded()}>
        {/* The same delayed spinner as the listing, for the same reason: a
            branch that answers in 20 ms should not blink. A branch opened for
            the first time over a slow cable can take seconds, and until now
            said so with a single "…". */}
        <Show
          when={!loading() || children()}
          fallback={
            <Show when={slowLoad()}>
              <div
                class="py-1"
                style={{ "padding-left": `${(props.depth + 1) * 12 + 8}px` }}
              >
                <Spinner label={t()("listing.loading")} size={12} />
              </div>
            </Show>
          }
        >
          <For each={children() ?? []}>
            {(child) => (
              <Node
                storageId={props.storageId}
                path={[...props.path, { handle: child.handle, name: child.name }]}
                handle={child.handle}
                name={child.name}
                depth={props.depth + 1}
              />
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
};

const FolderTree: Component = () => (
  <Show
    when={storageId()}
    fallback={<div class="p-3 text-xs text-fg-muted">{t()("tree.empty")}</div>}
  >
    {(id) => (
      <div class="p-1">
        <Node
          storageId={id()}
          path={[]}
          handle={null}
          name={currentStorage()?.description ?? t()("tree.root")}
          depth={0}
        />
      </div>
    )}
  </Show>
);

export default FolderTree;
