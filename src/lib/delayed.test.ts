import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createDelayed } from "./delayed";

describe("createDelayed", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Drives one instance and hands back the levers, disposing with the test. */
  const harness = () => {
    let dispose!: () => void;
    let set!: (v: boolean) => void;
    let shown!: () => boolean;
    createRoot((d) => {
      dispose = d;
      const [source, setSource] = createSignal(false);
      set = setSource;
      shown = createDelayed(source, 200);
    });
    return { set, shown, dispose };
  };

  /**
   * The case the delay exists for: a folder that answers quickly must not
   * flash a spinner. Nothing is ever shown here, at any point.
   */
  it("stays silent for work that finishes before the threshold", () => {
    const { set, shown, dispose } = harness();

    set(true);
    vi.advanceTimersByTime(150);
    expect(shown()).toBe(false);

    set(false);
    vi.advanceTimersByTime(1000);
    expect(shown(), "a cancelled timer must not fire later").toBe(false);

    dispose();
  });

  it("shows once the work outlasts the threshold", () => {
    const { set, shown, dispose } = harness();

    set(true);
    vi.advanceTimersByTime(199);
    expect(shown()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(shown()).toBe(true);

    dispose();
  });

  /** Off is immediate: a spinner outliving its content is worse than none. */
  it("hides the moment the work ends", () => {
    const { set, shown, dispose } = harness();

    set(true);
    vi.advanceTimersByTime(500);
    expect(shown()).toBe(true);

    set(false);
    expect(shown(), "no delay on the way down").toBe(false);

    dispose();
  });

  /**
   * Clicking through folders restarts the wait each time. Without a fresh
   * timer per rising edge, a run of quick loads would accumulate into a
   * spinner that appears during one that was itself fast.
   */
  it("restarts the wait on each new run", () => {
    const { set, shown, dispose } = harness();

    for (let i = 0; i < 5; i++) {
      set(true);
      vi.advanceTimersByTime(150);
      set(false);
      vi.advanceTimersByTime(10);
    }
    expect(shown()).toBe(false);

    set(true);
    vi.advanceTimersByTime(200);
    expect(shown(), "a genuinely slow one still speaks up").toBe(true);

    dispose();
  });

  /** Disposing has to take the pending timer with it. */
  it("does not fire after its owner is gone", () => {
    const { set, shown, dispose } = harness();

    set(true);
    vi.advanceTimersByTime(50);
    dispose();
    vi.advanceTimersByTime(1000);

    expect(shown()).toBe(false);
  });
});
