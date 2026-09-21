# Implementation notes — round-trip corruption fixes

Companion to `round-trip-corruption-plan.md`. Records where reality diverged from the plan as written.

## What shipped vs. what the plan first proposed

- The plan originally scoped only fixes #2 (hr) and #4a (table padding), deferring #4b (blank line around headings) per a prior team decision recorded in the stale root `PLAN.md`. Review comments on the plan doc overrode that: the deferral predates this fork and doesn't bind it. Fix #4b was folded in as "change 3" and implemented in the same pass.
- Bug 4's root cause was mis-described in my first pass at the plan as "GFM plugin pads every column to the widest cell for alignment" (cross-row column alignment). Reading `@joplin/turndown-plugin-gfm`'s actual `cell()` source showed that's wrong — it's a flat per-cell minimum-width-3 rule, unrelated to other rows. The plan doc was corrected before implementing; the fix itself (`.replace(/ {2,}\|/g, " |")`) works either way, but the stated root cause in the final plan reflects the real mechanism.

## Test fallout not fully anticipated in the plan

The plan's "Test strategy" section only mentioned adding two new tests. In practice, removing the blank-line-stripping in `normalizeBlockSpacing()` broke 8 pre-existing tests that had the old (buggy) behavior baked into their expected output as if it were correct:

- `packages/app/test/critic-markup.test.ts` — 5 tests, including 3 fixture-based round-trip tests
- `packages/app/test/page-card.test.tsx` — 3 tests, including one `it.each` with two cases (only the "after a heading" case needed a different expectation than the "as first body block" case, since only one of them has a heading in the input)
- Three fixture files needed a blank line added after their leading heading to stay round-trip-stable: `criticmarkup-basic.md`, `frontmatter-table-yaml.md`, `mixed-roundtrip.md`

All were updated to the new, correct expected output rather than loosened. None of this was predictable from reading `markdown.test.ts` alone — the fixture-backed tests live in a separate `packages/app/test/` directory that isn't colocated with the source files, so a plain `grep` for "normalizeBlockSpacing" in `src/` wouldn't have surfaced them.

## Verification gap

Bug 5 (live resync clobber) and bug 1 (links vanishing) remain unverified beyond what's in the plan's Findings section — no code changed for either. Bug 1 especially needs the actual failing document before further work; guessing at synthetic repros already burned significant effort with nothing to show for it.

## Sandbox note (not really a code decision, but worth recording)

`pnpm check` and `pnpm test:smoke` both fail under the default Bash sandbox because the server package's test suite binds real listening sockets, which the sandbox blocks (`EPERM`). This is pre-existing and unrelated to the changes here — confirmed by running the server package's tests unsandboxed on their own, before touching any code, and they passed. Both full-suite runs needed `dangerouslyDisableSandbox: true`.
