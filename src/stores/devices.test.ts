import { beforeEach, describe, expect, it } from "vitest";
import { __test, devices, selected } from "./devices";
import type { DeviceDto } from "@/ipc/types";

/**
 * The selection rules, which is where hotplug can do real damage: a USB event
 * fires for *any* device on the bus, and each one replaces this list. Getting
 * these wrong means someone plugging in a mouse closes the user's open session.
 */

const device = (serial: string, state: DeviceDto["state"] = "ready"): DeviceDto => ({
  serial,
  locationId: `0000${serial}`,
  manufacturer: "vivo",
  model: "V2036",
  state,
});

beforeEach(() => {
  __test.setDevices([]);
  __test.setSelected(null);
});

describe("applyList", () => {
  it("picks the only usable device so the user has nothing to do", () => {
    __test.applyList([device("A")]);
    expect(selected()).toBe("A");
  });

  it("refuses to guess between two devices", () => {
    __test.applyList([device("A"), device("B")]);
    expect(selected()).toBeNull();
  });

  it("does not auto-pick a device that is only charging", () => {
    __test.applyList([device("A", "unauthorized")]);
    expect(selected()).toBeNull();
    expect(devices()).toHaveLength(1);
  });

  /** The one that matters: an unrelated USB event must not close the session. */
  it("keeps the selection when the device is still attached", () => {
    __test.applyList([device("A"), device("B")]);
    __test.setSelected("B");

    __test.applyList([device("A"), device("B")]);

    expect(selected()).toBe("B");
  });

  it("drops the selection when that device is unplugged", () => {
    __test.applyList([device("A"), device("B")]);
    __test.setSelected("B");

    __test.applyList([device("A")]);

    // Falls through to the auto-pick rule: one usable device is left.
    expect(selected()).toBe("A");
  });

  it("clears the selection when everything is unplugged", () => {
    __test.applyList([device("A")]);
    __test.applyList([]);
    expect(selected()).toBeNull();
    expect(devices()).toEqual([]);
  });

  /**
   * A phone switching out of charging-only keeps its serial. The list changes,
   * the identity does not — and it must become selectable at that moment
   * without the user touching anything.
   */
  it("picks up a device the moment it leaves charging-only mode", () => {
    __test.applyList([device("A", "unauthorized")]);
    expect(selected()).toBeNull();

    __test.applyList([device("A", "ready")]);
    expect(selected()).toBe("A");
  });
});
