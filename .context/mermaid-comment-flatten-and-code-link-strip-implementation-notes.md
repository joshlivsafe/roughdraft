# Implementation notes: mermaid-comment flatten + code-link strip

Two bugs reported by another session's review of an open document. No prior plan doc — root cause was diagnosed inline, then fixed following AGENTS.md's Prove-It pattern (failing test first).

## Bug 1: comment anchored inside a code/mermaid block flattens it to one line

**File:** `packages/app/src/critic-markup/index.ts`, `addCriticCodeBlockRule`.

**Root cause:** when a code block's `<code>` element contains a `span[data-comment-ids]` or `span[data-critic-change-kind]`, the rule ran `service.turndown(codeElement.innerHTML)` on just the *contents* (not the `<code>` element itself). Turndown's `collapseWhitespace` only skips whitespace-collapsing for a subtree rooted at an actual `<pre>`/`<code>` DOM node; handed a bare wrapper, every `\n` in the code/diagram text collapsed to a space.

**Fix path considered and rejected:** wrapping the fragment in a real `<pre><code>...</code></pre>` (to get Turndown's `preformattedCode` / `isPreOrCode` protection) doesn't work here:
- A `<pre><code>` containing a comment/change span matches this very rule's own filter again — infinite recursion.
- A bare top-level `<code>` (not inside `<pre>`) instead matches Turndown's *inline* code rule, which unconditionally does `content.replace(/\r?\n|\r/g, ' ')` in its own replacement function — newlines get stripped regardless of any `preformattedCode` setting.

**Fix applied:** protect newlines by character substitution instead of by DOM shape. Before calling `service.turndown(...)`, swap every `\n`/`\r\n`/`\r` in the HTML string for ` ` (a placeholder Turndown's whitespace collapsing won't touch), then swap it back to `\n` in the returned markdown. Keeps using the same shared `service` (so `criticComment`/`criticChange` rules still apply to nested spans) — no second TurndownService instance, no rule duplication.

**Test:** `packages/app/src/critic-markup/code-block-comments.test.ts` — builds a ProseMirror doc JSON directly (mermaid code block with a `commentRef`-marked run in the middle) and asserts the fenced output keeps 4 separate lines instead of collapsing to 1. A second test confirms a plain code block with no comment still round-trips unchanged (no regression on the common path, which still goes through Turndown's default `fencedCodeBlock` rule untouched).

## Bug 2: a link whose text is a code span gets dropped (regression)

**File:** `packages/app/src/editor-extensions.ts:714-718`.

**Root cause:** `MarkdownCode.excludes` listed `link` alongside `bold italic strike`. ProseMirror's `Mark.addToSet` drops an existing mark from the set whenever a newly-applied mark's `excludes` names it — so applying the Code mark to already-linked text silently discarded the Link mark. CommonMark allows a code span as link text (`` [`file.md`](path) ``), so `link` didn't belong in that list; `bold`/`italic`/`strike` still do (a code span can't semantically contain emphasis markers).

**Fix:** `excludes: "bold italic strike"` (removed `link`).

**A real trap this hit, worth flagging for future work in this area:** an unqualified relative href like `docs/RESEARCH.md` (no `./` prefix, no protocol) fails Tiptap Link's own `isAllowedUri` validation on its own — regardless of the Code-mark exclusion — because of what looks like an accidental character-range bug in its own regex (`[^a-z+.-:]` reads `.-:` as a range from `.` to `:`, which swallows `/` and digits). A raw link like that gets silently dropped by ProseMirror's HTML parser *before* Code/Link interaction even comes into play. In the live app this is masked because `PageCard.tsx` always supplies a `resolveLinkUrl` that turns same-project document links into a full `http://…` URL before they ever reach the editor's DOM parsing, so it doesn't currently manifest as a user-visible bug — but it means any test (or any future code path) that renders a raw, unresolved relative href straight into HTML will see the link mark vanish even without code formatting involved. Not fixed here (out of scope — the two reported bugs didn't need it, and the live resolution path already avoids it), but worth knowing if links look flaky in some other untested load path.

**Test:** `packages/app/src/critic-markup/code-link-round-trip.test.ts`. Supplies a stub `resolveLinkUrl` (mirrors what the real app always provides) so the href passes Tiptap's validation, isolating the Code/Link exclusion behavior under test. Covers both a table-cell case (matches the exact bug report) and plain body text.

## Verification run

- `pnpm --filter app exec vitest run src/critic-markup src/markdown.test.ts` — 27/27 pass.
- `pnpm check` (lint + selectors + test + build) — sandboxed run hit `EPERM: listen 127.0.0.1` in `packages/server/src/cli.test.ts` (pre-existing sandbox limitation documented in the CLAUDE.md instructions for this repo — server tests bind a real socket), unrelated to this change. Re-ran with the sandbox disabled: clean pass.
- `pnpm test:smoke` — clean pass (unsandboxed, same reason).
