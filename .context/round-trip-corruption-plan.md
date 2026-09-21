# Fix round-trip corruption on open/review (RAID log bugs)

## Goal

Fix the reformatting/corruption that shows up when a `.md` file goes through Roughdraft's open → (review) → save round trip, so RAID-log-style documents stop producing diff noise or losing content on every open.

## Non-goals

- The live-resync/external-write-clobber bug (#5 below) gets a root-cause investigation plan, not a fix — the trigger isn't nailed down yet.
- Bug #1 (links vanishing) does not currently reproduce (see Findings). This plan proposes locking in the passing behavior with regression tests and asks for the actual failing file before spending more effort chasing it blind.

## Findings (this session)

I ran the actual conversion pipeline (`criticMarkdownToEditorState` / `editorStateToCriticMarkdown` in `packages/app/src/critic-markup/index.ts`) through `vitest` with jsdom, and separately loaded a real document in the actual `roughdraft-dev` server + a live Chrome tab, to check each reported bug against the current `main` (commit `1786e68`). Scratch probes were deleted after use; nothing here needs a `.context` companion file.

### Bug 1 — inline links vanish (headings/prose) — **could not reproduce**

Tried, all passed correctly (link mark survived) in both the headless pipeline and a real browser tab:

- a heading with a link (`## Hello [world](./foo.md)`)
- a paragraph with a link
- a table-cell link
- a heading link sitting in the same doc as an unrelated CriticMarkup comment + YAML endmatter
- 3x repeated open→save→reopen cycles on a heading link
- a synthetic RAID-log-shaped doc (H1 + H2 + prose link + table + H2-with-link) round-tripped twice

Real-browser check: navigated the actual `roughdraft-dev` server to a repro file with a heading link, prose link, and table-cell link, and read the live ProseMirror DOM — all 4 anchors were present, including the one whose `parentTag` was `H2`.

I could not get autosave to actually write to disk in this scratch setup (see bug 5 notes) to test a genuine post-edit reopen, which is the one path I didn't get to exercise.

**Conclusion:** whatever is dropping links in headings on `RAID_LOG.md`/`RAID_CONVENTIONS.md` isn't reproducible with a generic synthetic doc — it likely depends on something specific to those files (a particular inline construct, an existing corruption from a prior round trip compounding, or the save path specifically, not the open path). Don't re-guess further; get a copy of the actual pre-corruption `RAID_LOG.md`/`RAID_CONVENTIONS.md` content (or the smallest heading+link snippet that still triggers it) before touching `MarkdownLink` in `editor-extensions.ts:682` or the parse side of `markdown.ts`.

### Bug 2 — `---` thematic break becomes `* * *` — **confirmed, fixed**

Repro (headless): `"Above.\n\n---\n\nBelow.\n"` round-tripped to `"Above.\n\n* * *\n\nBelow.\n"`.

Root cause: `createTurndownService()` in `packages/app/src/markdown.ts` never registered a rule for `<hr>`, so it fell through to Turndown's built-in default rule, which always emits `* * *`. Every other block type in this file (tables, links, images, list items, strikethrough, raw blocks) gets an explicit `addRule` override that preserves the source's own syntax; `hr` was the one gap.

### Bug 3 — YAML endmatter flattened — **not reproduced as described; found a different, real defect nearby**

I could not reproduce literal newline-collapsing. `serializeReviewEndmatter` (`critic-markup/index.ts:358-405`) does a real `stringify()` from the `yaml` package when it decides to regenerate, and that produces normal multi-line block YAML, not single-line output — confirmed by running it directly. Two other specific reformatting theories (unquoted/no-millis `at:` timestamp, an unrelated extra top-level key like `customMeta:`) also round-tripped byte-for-byte unchanged, because `serializeReviewEndmatter` returns the original `existingEndmatter` string untouched whenever `parsed.comments`/`parsed.suggestions` are semantically equal to the live comment/change maps (`areEndmatterMapsEqual`, line 304).

The real defect: **that equality check is the only thing standing between "keep the user's exact YAML" and "throw it away and regenerate from scratch."** The moment it's not equal — a new comment, an edited comment body, a comment resolved, anything — `serializeReviewEndmatter` (line 390-404) rebuilds the endmatter as `{ ...parsed.data, comments: {...}, suggestions: {...} }` and re-`stringify()`s the whole thing. That discards:

- key order in `parsed.data` beyond what's preserved by object spread
- YAML comments (`#`) anywhere in the original endmatter
- block-scalar style choices (`|`, `>`) on fields the user wrote that way, since `stringify()` picks its own style per value
- any blank-line/whitespace formatting the user had

For a document with real, actively-changing review comments (which is Roughdraft's core use case), this fires on essentially every save once there's more than one comment thread, and produces the kind of large, structural YAML diff the previous session described — "flattened" may have been this session's shorthand for "unrecognizably reformatted," not literal single-lining.

**Fix direction (not implemented this session):** stop wholesale-regenerating `data` with `stringifyYaml`. Either (a) use `yaml`'s `parseDocument`/CST API to mutate only the changed comment/suggestion entries in place and `.toString()` the same document (preserves comments, ordering, blank lines, scalar style), or (b) if that's too large a lift, at minimum diff at the entry level and only rewrite the `comments`/`suggestions` subtrees that actually changed, leaving everything else (including unrelated top-level keys) byte-identical. Needs a decision before implementing — see Open Questions.

### Bug 4 — table formatting drift — **confirmed, two distinct causes, both fixed**

Repro (headless):

```
input:  | ID | Status |
        | --- | --- |
        | R-1 | n/a |

        ## Next section

output: | ID  | Status |
        | --- | --- |
        | R-1 | n/a |
        ## Next section
```

Two separate mechanisms, both real:

1. **Cell padding.** `| ID | Status |` → `| ID  | Status |` (added space). Root cause: `@joplin/turndown-plugin-gfm`'s `cell()` helper pads every cell to a **minimum of 3 characters** — it's not cross-row column alignment at all, just a per-cell minimum-width rule, unrelated to other rows' widths.
2. **Blank line before heading removed.** `normalizeBlockSpacing()` unconditionally stripped any blank line immediately before an ATX heading, regardless of what precedes it. This was previously deferred in the stale root `PLAN.md` in this repo (`packages/app` root, "Out of scope" section) — **that deferral predates this fork and doesn't bind it, per review. Decision: fix it now, folded in as change 3 below.**

### Bug 5 — live resync clobbers external writes — **not reproduced; real guard exists, mechanism unclear**

`DocumentWorkspace.tsx` already has a save-conflict guard: `documentDiskChangeState`, a `saveBlocked` flag threaded into `PageCard.tsx`'s `scheduleSave`/`performSave` (`PageCard.tsx:2164-2228`), and UI states for "Save conflict" / "Autosave paused" with copy that says autosave pauses specifically so external changes aren't overwritten (`DocumentWorkspace.tsx:136-140`). So the intent to prevent exactly this bug already exists in the code.

I tried to reproduce it live (scratch file outside a real project, opened via `roughdraft-dev-roughdraft`, edited via a real browser click+keystroke) but autosave never fired within ~10s and the file on disk never changed at all, even though the editor showed a pending suggestion. That's a second, separate oddity worth noting but I didn't chase it — it may just be an artifact of editing a file outside a normal project/backend context rather than a real bug.

**Recommendation:** don't guess at a fix. This is exactly the kind of boundary (filesystem watcher + debounced autosave race) the repo's own `slog` skill exists for. Next session: open a real project document, mint an `slog` run, add logs around `scheduleSave`/`performSave` in `PageCard.tsx` and whatever emits `documentDiskChangeState`, reproduce with an external `Write` while the tab is open, and read the log to find the actual race before writing a fix.

## Proposed changes — IMPLEMENTED (this session)

### 1. `packages/app/src/markdown.ts` — preserve `---` thematic breaks

Added an explicit turndown rule for `hr`, alongside the other `addRule` calls in `createTurndownService()`:

```ts
service.addRule("thematicBreak", {
  filter: "hr",
  replacement() {
    return "\n\n---\n\n";
  },
});
```

### 2. `packages/app/src/markdown.ts` — stop padding table cells to a minimum width

Fixed inside `tiptapHeaderTable`'s `replacement()`, after the GFM plugin has already produced its (padded) `content`:

```ts
const lines = content
  .replace(/\n+/g, "\n")
  .trim()
  .split("\n")
  .map((line) => line.replace(/ {2,}\|/g, " |"));
```

Scoped to `tiptapHeaderTable` only (tables with a header row) — deliberately left the headerless-table path (`headerless-table.md` fixture) untouched, since its existing 3-space empty-header-cell padding is unrelated GFM-required filler, not the reported drift.

### 3. `packages/app/src/markdown.ts` — stop stripping blank lines around headings (folded in per review)

Removed the two regex replacements in `normalizeBlockSpacing()` that stripped the blank line immediately before/after any ATX heading. A ProseMirror doc has no concept of "was there a blank line here in the source" — so "strip it" was indistinguishable from "delete a blank line the user actually wrote," which is exactly the reported corruption. The function now only collapses runs of 3+ newlines to 2:

```ts
export function normalizeBlockSpacing(md: string): string {
  return md.replace(/\n{3,}/g, "\n\n");
}
```

Net effect: every heading now always gets exactly one blank line before and after it (Turndown's own default heading spacing, previously stripped). This is a real, visible behavior change — a doc that intentionally had no blank line between adjacent headings/blocks will gain one on its next save. Traded deliberately: preserving arbitrary existing spacing isn't recoverable from the doc model, and "always blank line around headings" is a defensible, standard convention (matches markdownlint's MD022) rather than the previous "always strip it," which actively destroyed content.

## Test strategy — done

All three fixes got unit tests in `packages/app/src/markdown.test.ts` (new `thematic break round-trip` and `table cell padding round-trip` describe blocks), following the existing pattern (real TipTap-shaped HTML in, exact markdown string out). Per `AGENTS.md`'s Bug Fix Workflow, each test was confirmed red against pre-fix code, then green after the fix.

Fixing #3 broke 8 pre-existing tests that had baked the old (buggy) no-blank-line-around-headings behavior into their expected output — in `packages/app/test/critic-markup.test.ts`, `packages/app/test/page-card.test.tsx`, and three markdown fixtures (`criticmarkup-basic.md`, `frontmatter-table-yaml.md`, `mixed-roundtrip.md`). Updated each to the new correct expected output rather than loosening the assertions. One of those (`does not treat horizontal rules and fenced YAML examples as review endmatter`) also had its `"* * *"` assertion updated to `"---"`, since fix #1 changed what that fixture's thematic break round-trips to.

Verified: `pnpm check` (lint, test selectors, all three packages' tests, build) passes clean, and `pnpm test:smoke` (Playwright) passes clean. Both needed `dangerouslyDisableSandbox` — the sandbox blocks the server package's tests from binding a listening socket (`EPERM` on `listen`), unrelated to these changes; confirmed by running the server package's tests unsandboxed on their own before touching anything, which also passed.

No realistic/boundary-crossing verification was needed beyond that — these are pure string-transform bugs, not filesystem/browser/OS boundary bugs. Bug 5, if picked up later, does need the `slog` + real browser flow described above before trusting any fix.

## Risks

- The `hr` fix is isolated and low-risk.
- The table-padding fix touches the same code path as the code-span/table fix in `1786e68` — the full `markdown.test.ts` suite (not just the new cases) was re-run after changing `tiptapHeaderTable` and passes.
- The blank-line-around-headings change is a real, visible formatting change for any document that didn't already have blank lines around its headings — every such document will show a one-time diff of added blank lines on its next save through Roughdraft. Worth a heads-up in the PR description so it isn't mistaken for new corruption.
- Bug 3's real fix (preserving YAML structure) is a bigger lift than it looks from the outside; not started — see Open Questions. Shipping nothing here is better than shipping a half-fix that still discards comments/formatting in a different way.

## Open Questions

- Bug 3: use `yaml`'s `parseDocument`/CST for in-place mutation (preserves everything but is a bigger refactor of `serializeReviewEndmatter`), or accept diff noise on entry-level changes but stop touching unrelated keys (smaller, still-lossy fix)? Needs a decision before implementation.
- Bug 1: waiting on the actual failing file/snippet from the user (or the other session) before further investigation.
- Bug 5: waiting on an `slog`-instrumented repro in a real project before proposing a fix.

## Housekeeping noticed, not acted on

- Root-level `PLAN.md` (this repo) documents the already-fixed list-item blank-line bug (commit `3768da2`) and is stale — worth deleting once you've confirmed you don't need it, but I left it alone since it wasn't part of this task.
- `packages/server/src/cli.ts`, `mcp.ts`, `cli.test.ts`, `mcp.test.ts`, `pnpm-workspace.yaml`, and a new `packages/server/src/review-events-watch-client.ts` are already modified/untracked from before this session (unrelated in-progress work, not touched here).

---
comments:
  c1:
    body: Agreed, done — see change 3 and Bug 4 item 2 above.
    by: AI
    at: "2026-09-21T18:05:00.000Z"
    re: c1
  c2:
    body: Folded in as change 3 and implemented. All three fixes (hr, table padding, blank-line-around-headings) are done, tested, and `pnpm check` + `pnpm test:smoke` pass clean.
    by: AI
    at: "2026-09-21T18:05:00.000Z"
    re: c2
