import { createSignal, createEffect, onCleanup } from "solid-js";

/**
 * Follows `source`, but only turns **on** after it has stayed on for `ms`.
 * Turning off is immediate.
 *
 * This is what keeps a loading indicator from being its own kind of noise. A
 * folder on this device answers in anywhere from 17 ms to several seconds;
 * showing a spinner for the fast ones means a flicker on every click, which
 * reads as the interface stuttering rather than as work being done. Below the
 * threshold the operation is perceived as instant and needs no explanation
 * at all — what needs explaining is the wait.
 *
 * The asymmetry is the point: delaying the *off* edge as well would leave a
 * spinner on screen after the content beneath it had already arrived.
 */
export function createDelayed(source: () => boolean, ms: number): () => boolean {
  const [shown, setShown] = createSignal(false);

  createEffect(() => {
    if (!source()) {
      setShown(false);
      return;
    }
    // A fresh timer per rising edge, cleared by the effect re-running or the
    // owner disposing. Without the cleanup a timer from a load that finished
    // early would fire later and switch on a spinner for nothing.
    const timer = setTimeout(() => setShown(true), ms);
    onCleanup(() => clearTimeout(timer));
  });

  return shown;
}

/**
 * How long something may take before it has to admit it is taking a while.
 *
 * Under this, a person reads the result as immediate; over it, silence starts
 * to read as breakage. It is one number rather than a per-call-site choice so
 * that every part of the app waits the same amount before speaking up.
 */
export const SPINNER_DELAY_MS = 200;
