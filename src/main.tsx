/* @refresh reload */
import { render } from "solid-js/web";
import { ErrorBoundary } from "solid-js";
import Layout from "./components/Layout";
import "./styles/index.css";
import "./stores/theme";

/**
 * A component that throws on first render otherwise paints nothing at all — a
 * white window with no message anywhere. The boundary makes that failure mode
 * impossible to miss.
 */
const Fatal = (err: unknown) => (
  <div class="h-full space-y-3 overflow-auto p-6">
    <div class="text-sm font-medium text-danger">ADX не смог запустить интерфейс.</div>
    <pre class="whitespace-pre-wrap rounded bg-bg-muted p-3 text-xs text-fg">
      {(err as Error)?.stack ?? (err as { message?: string })?.message ?? String(err)}
    </pre>
  </div>
);

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

render(
  () => (
    <ErrorBoundary fallback={Fatal}>
      <Layout />
    </ErrorBoundary>
  ),
  root,
);
