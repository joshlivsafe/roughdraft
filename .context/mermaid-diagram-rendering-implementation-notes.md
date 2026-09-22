# Implementation Notes: Mermaid Diagram Rendering

Companion to `.context/mermaid-diagram-rendering-plan.md`. Records where reality diverged from the plan.

## What shipped

- `packages/app/src/components/MermaidCodeBlockView.tsx` — the mermaid node view: lazy-loads `mermaid`, renders SVG via `mermaid.render()`, click-to-edit / Preview toggle, inline error state on render failure, dark/light theme via `matchMedia`, forces source (editing) view whenever the block has an active `commentRef`/`criticChange` mark or is empty.
- `packages/app/src/components/CodeBlockView.tsx` — dispatcher wired into `MarkdownCodeBlock.addNodeView()`; branches to the mermaid view only when `node.attrs.language === "mermaid"`, otherwise reproduces the extension's own default `<pre><code class="language-x">` output so every other language is visually unchanged.
- `packages/app/src/markdown.test.ts` — round-trip fixtures proving a `language-mermaid` fence (including a blank line inside it, backtick-like text inside it, and one adjacent to a heading/list) survives open → save unchanged, beyond the pre-existing heading-blank-line normalization.
- `packages/app/src/components/MermaidCodeBlockView.test.tsx` — node view behavior tests, mounted through real `useEditor` + `<EditorContent>` (not a bare `new Editor({ element })` — see the comment in the test file for why that distinction matters for `ReactNodeViewRenderer`).

## Divergences from the plan

- **Component test coverage ended up narrower than planned, for a real environment reason, not a shortcut.** jsdom has no SVG layout engine (no `getBBox`/`getComputedTextLength`), so `mermaid.render()` always throws in the vitest/jsdom environment. That made a "renders and shows the default preview state" unit test infeasible — jsdom cannot prove it either way. Rather than fake it, the test suite: (a) proves the dispatcher routes mermaid vs. non-mermaid blocks correctly, (b) proves the error-handling path (this is the one case jsdom's limitation lets us exercise for real — a render failure shows the inline error and keeps the block in editable source view, not a mock), and (c) proves the comment-anchor-forces-source-view rule. The actual "does a valid diagram render as SVG" behavior was verified separately against the real running app in a real browser (see below) per this repo's Realistic Verification requirement — that's the residual verification gap the plan flagged as required, now closed by browser evidence rather than a jsdom test.
- **CriticMarkup interaction risk (flagged as the trickiest open question in the plan) resolved more simply than expected.** No changes to `DocumentReviewRail.tsx` or `useCommentAnchorLayout.ts` were needed. The node view just inspects the code block node's own marks (`commentRef`/`criticChange`) and forces source view — the existing comment rail and anchor layout machinery works against the underlying ProseMirror doc/marks regardless of which visual state the node view is in, since the marked text is still present in `NodeViewContent` (just hidden via `display: none` when previewing, never unmounted). This also means undo/redo, selection, and typing all keep working normally in both visual states, since ProseMirror always sees the same content node.
- **`NodeViewWrapper`/`NodeViewContent` pass all props straight to the DOM element** (confirmed by reading `@tiptap/react`'s source, not assumed) — so `data-mermaid-editing`, `className`, etc. all work as expected without extra plumbing.
- **Security level:** shipped with `securityLevel: "strict"` as the plan's default choice, not `"sandbox"`. Nothing in the verification pass hit a legitimate diagram feature that strict mode blocks (no `click` directives were tested — none exist in the codebase's current Mermaid usage as far as this pass checked). If that changes, it's a one-line config change, not a redesign.
- **Bundle-size goal confirmed directly**, not just assumed: `pnpm build`'s output shows `mermaid.core-*.js` (682 KB) as its own separate chunk, distinct from the main `index-*.js` entry — the dynamic `import("mermaid")` is genuinely code-split.

## Verification performed

- `pnpm exec tsc -b` — clean.
- `pnpm vitest run` (packages/app) — 240 tests passed, including the new mermaid round-trip and node-view tests.
- Real browser verification via the built `roughdraft` CLI (globally `npm link`'d to this checkout — `pnpm build` at the repo root updates it in place) against a throwaway doc with three fences: a valid diagram (rendered correctly as SVG, click-to-edit and Preview toggle both worked, no console errors), a deliberately invalid diagram (showed the inline parse error, stayed in editable source view, rest of the document unaffected), and a non-mermaid `javascript` block (rendered exactly as before, unaffected).

## Not done / deferred

- `docs/spec/ui-state-screenshot-guide.md` was not updated in this pass — deferred pending the user's sign-off on this implementation; worth doing as a small follow-up once the feature is confirmed final.
- `pnpm check`/`pnpm test:smoke` (full PR-workflow gate, including Playwright smoke tests) not yet run — planned as the last step before opening a PR.
