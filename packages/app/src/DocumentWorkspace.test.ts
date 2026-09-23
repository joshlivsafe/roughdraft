import { describe, expect, it } from "vitest";
import { getReviewHandoffSelfHealAction } from "./DocumentWorkspace";

describe("getReviewHandoffSelfHealAction", () => {
  it("closes the popover when recovering from undelivered once a watcher reappears", () => {
    expect(
      getReviewHandoffSelfHealAction({
        reviewHandoffState: "undelivered",
        reviewWatcherCount: 1,
        sawNoWatcherAfterNotified: false,
      }),
    ).toEqual({
      nextState: "idle",
      closePopover: true,
      nextSawNoWatcherAfterNotified: false,
    });
  });

  it("does nothing while undelivered and still no watcher", () => {
    expect(
      getReviewHandoffSelfHealAction({
        reviewHandoffState: "undelivered",
        reviewWatcherCount: 0,
        sawNoWatcherAfterNotified: false,
      }),
    ).toEqual({
      nextState: null,
      closePopover: false,
      nextSawNoWatcherAfterNotified: false,
    });
  });

  it("arms the flag when a notified watcher briefly disappears", () => {
    expect(
      getReviewHandoffSelfHealAction({
        reviewHandoffState: "notified",
        reviewWatcherCount: 0,
        sawNoWatcherAfterNotified: false,
      }),
    ).toEqual({
      nextState: null,
      closePopover: false,
      nextSawNoWatcherAfterNotified: true,
    });
  });

  it("closes the popover when a notified watcher reconnects after having disappeared", () => {
    expect(
      getReviewHandoffSelfHealAction({
        reviewHandoffState: "notified",
        reviewWatcherCount: 1,
        sawNoWatcherAfterNotified: true,
      }),
    ).toEqual({
      nextState: "idle",
      closePopover: true,
      nextSawNoWatcherAfterNotified: false,
    });
  });

  it("leaves a still-connected notified watcher alone", () => {
    expect(
      getReviewHandoffSelfHealAction({
        reviewHandoffState: "notified",
        reviewWatcherCount: 1,
        sawNoWatcherAfterNotified: false,
      }),
    ).toEqual({
      nextState: null,
      closePopover: false,
      nextSawNoWatcherAfterNotified: false,
    });
  });

  it("resets the flag once state leaves notified", () => {
    expect(
      getReviewHandoffSelfHealAction({
        reviewHandoffState: "idle",
        reviewWatcherCount: 0,
        sawNoWatcherAfterNotified: true,
      }),
    ).toEqual({
      nextState: null,
      closePopover: false,
      nextSawNoWatcherAfterNotified: false,
    });
  });
});
