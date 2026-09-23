# Review handoff "double click" bug — implementation notes

## Reported symptom

After commit `8bd9668` (grace-period fix for a false "undelivered" handoff),
clicking "I'm done" showed a longer "Sending" spinner, then briefly
"No agent is watching now", then the comment-composer popover reopened on
its own. Clicking "I'm done" again then completed normally.

## Root cause (confirmed by live reproduction, not just code reading)

`packages/server/src/review-events.ts`: the chunked long-poll's resume
cursor was off by one. When a `wait()` call times out with nothing new, it
told the client to resume with `afterSequence: this.nextSequence` — the
sequence number the *next* event will receive. `matchesWaiter` requires
strictly-greater (`event.sequence <= afterSequence` → no match), so the very
next real event is always assigned exactly that number and therefore always
fails to match. Once a watcher idles past one chunk boundary (`roughdraft
open`'s chunks are 240s in production), every subsequent event is
permanently invisible to that connection — not a rare race, a deterministic
miss, reproduced with two consecutive real HTTP calls against a genuinely
connected `roughdraft open` process, both returning `delivered:false` at
exactly the 3s grace-period ceiling.

This is also why `emitAwaitingDelivery`'s grace-period pickup (added in
`8bd9668` to paper over exactly this kind of gap) never actually recovers
the delivery: `notifyPickup` is driven by the same broken `matchesWaiter`
comparison, so the reconnecting `wait()` call never sees the event as
"existing" either.

Verified end-to-end after the fix: a real `roughdraft open` process left
idling past its first 240s chunk boundary, then a completion event posted
against it, delivered in 9ms and the CLI process exited 0 — instead of
blocking the full 3s grace period and reporting undelivered.

Separately, `packages/app/src/DocumentWorkspace.tsx` had a real but
secondary bug: the client-side self-heal effect (flips `undelivered` back
to `idle` once its independent watcher-count poll notices a watcher again)
never closed the popover it had opened. That's the "dropdown opens on its
own" — the popover was never re-opened, it just never got closed after the
self-heal, and by then it's rendering the *idle*-state content (the overall
comment composer) instead of whatever it showed before.

## Fix

- `review-events.ts`: both `resultForEvents(...)` call sites (`wait()`'s
  early-return and `resolveWaiter()`) now pass `this.latestSequence()`
  (`nextSequence - 1`) instead of the raw `nextSequence` counter. Same
  helper `fromNow` connections already used correctly.
- `DocumentWorkspace.tsx`: extracted the self-heal effect's branching into
  a pure `getReviewHandoffSelfHealAction()` (same pattern as the existing
  `isReviewHandoffDisabled`/`getReviewHandoffButtonLabel` exports) so it's
  unit-testable without a component harness, and made it also report
  `closePopover: true` on both recovery paths.

## Test strategy

- `review-events.test.ts`: new test mirrors `watchReviewEventsChunked()`'s
  real resume behavior exactly (uses the server's own returned
  `nextSequence` as the next `afterSequence`, across two idle timeouts)
  rather than the existing tests' shortcut of hardcoding `afterSequence: 0`
  — that shortcut is why the existing suite didn't already catch this.
  Confirmed it fails against the pre-fix code (deterministically, not
  flaky) and passes after.
- `DocumentWorkspace.test.ts` (new file, package had no component-level
  tests for this file before): direct table of inputs/outputs for
  `getReviewHandoffSelfHealAction`. Caught a real bug in my first draft of
  the extraction (a shorthand-property typo) before it ever reached the
  component.
- No component/E2E test exercises the popover-visibility behavior itself;
  `pnpm test:smoke`'s `review-handoff.spec.ts` covers the happy path but not
  this recovery path. Considered out of scope for this fix given the pure
  function above is a faithful 1:1 port of the effect's own logic.

## Realistic verification gap

Didn't add an automated integration test that drives the real 240s chunk
boundary (that's what `review-events.test.ts`'s fake-timer test now
encodes at 1s instead). Compensated for that gap by running the real thing
once by hand: a real `roughdraft open` CLI process, a real HTTP round trip
to the running dev server, timed across the actual 240s chunk boundary —
see the confirmation note above. Not repeated in CI since it's a 4-minute
wall-clock wait for a scenario the fake-timer test already covers
faithfully.
