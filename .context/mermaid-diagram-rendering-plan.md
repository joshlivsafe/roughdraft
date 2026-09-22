# Plan: Render Mermaid Diagrams in Roughdraft

## Goals

- A fenced code block tagged `mermaid` (` ```mermaid `) renders as an actual diagram (SVG) inside the Tiptap editor, not as plain code text.
- The underlying Markdown is untouched by this feature — a mermaid block is still an ordinary fenced code block on disk. Rendering is a presentation-layer concern only, consistent with ADR 0003 (round-trip contract) and ADR 0001 (Roughdraft edits the file directly, doesn't grow a parallel document model).
- The block stays editable: a reviewer can see the rendered diagram by default and drop into the raw Mermaid source to fix or extend it.
- Invalid Mermaid syntax degrades gracefully (inline error, not a crashed editor).

## Non-Goals

- No visual diagram editor (dragging shapes, WYSIWYG node placement). Source-only editing of Mermaid syntax.
- No export-to-PNG/SVG-file feature in this pass.
- No support for other diagram-as-code languages (PlantUML, Graphviz, etc.) — Mermaid only, since that's what's actually in use.
- No changes to the Markdown serialization format for code fences — this only affects how an existing `language-mermaid` code block renders inside the app.

## Current State (confirmed by reading the code)

- `packages/app/src/editor-extensions.ts:716` — `MarkdownCodeBlock` is `@tiptap/extension-code-block`, extended only to allow `commentRef`/`criticChange` marks inside its content. It has no custom `addNodeView()`, so every code block (any language, including `mermaid` today) renders as a plain `<pre><code class="language-mermaid">` — inert text.
- `packages/app/src/markdown.ts:347` — the `marked` renderer for `code` already emits `class="language-${lang}"` on the `<code>` element when a fence has an info string, and turndown's `codeBlockStyle: "fenced"` config round-trips it back out as a fenced block with the language tag. So a `language-mermaid` fence already survives open → edit-unrelated-text → save without being touched — this plan doesn't need to change the parse/serialize path, only what the block's node view renders.
- Package manager is `pnpm` (workspace root `pnpm-workspace.yaml`), editor stack is Tiptap 3 + React 19, no existing syntax-highlighting or diagram library in `packages/app/package.json`.

## Approach

Add a custom Tiptap NodeView for `MarkdownCodeBlock` that activates only when the block's language attribute is `mermaid`. All other languages keep today's plain rendering — no regression risk there.

### Rendering library

Use the `mermaid` npm package directly (not a React wrapper) via its `mermaid.render(id, source)` API, called from inside the node view's `useEffect`. It returns SVG markup client-side; no server round-trip, no build-time step. This fits Roughdraft's architecture (ADR 0004 — no new server-side state) — rendering happens entirely in the already-running browser app.

Lazy-load it with a dynamic `import("mermaid")` the first time a mermaid block is encountered, rather than a static top-level import. Mermaid is a large dependency (several hundred KB); most Roughdraft documents won't contain any diagrams, and ADR 0001's "quick open" framing argues against paying that cost on every document load.

### Node view behavior

Two states per block, source of truth is still the block's text content (no shadow state):

1. **Rendered** (default): the node view calls `mermaid.render()` on the block's current text and swaps in the resulting SVG. Not directly text-editable in this state.
2. **Source**: falls back to today's plain editable code block behavior (the existing `CodeBlock` rendering), so the user can type Mermaid syntax normally, including CriticMarkup marks/comments anchored inside it.

Entering source state:

- Clicking/focusing the rendered diagram switches it to source view (mirrors the click-to-edit pattern in Notion/Obsidian's Mermaid support, appropriate here since Roughdraft's whole point is inline editing, not a separate preview pane).
- The block must also open in source view automatically whenever it has an active `commentRef` or `criticChange` mark inside it, or when the review rail focuses a comment anchored inside it — a rendered SVG can't show an inline highlight/comment target, and CriticMarkup review (ADR 0002) must keep working inside code fences per that ADR's explicit callout.

Leaving source state (blur, or an explicit "Preview" action) re-renders from the current text.

### Error handling

Wrap the `mermaid.render()` call in try/catch. On failure, render an inline error state (the parse error message) instead of the diagram, and stay in source view so the user can immediately fix the syntax. Never let a bad diagram take down the rest of the document's editability.

### Security

Mermaid's default rendering can interpret `click` directives and, depending on config, inject HTML labels — not acceptable for a tool that opens arbitrary local files and (per ADR 0004's remote-document mode) files registered from another machine over the network. Configure `mermaid.initialize({ securityLevel: "strict" })` (or `"sandbox"` if strict proves too restrictive for legitimate diagrams the team uses) so a crafted `mermaid` fence can't execute script or arbitrary HTML in the editor's origin.

### Theming

Roughdraft has light/dark mode (see `UpdateNotice.tsx`/app-wide theme handling). Pass the current theme into `mermaid.initialize({ theme: ... })` and re-render open diagrams on theme change, so diagrams don't look broken in dark mode.

### Multiple diagrams per document

`mermaid.render()` requires a unique id per call. Derive it from the Tiptap node's stable position/id rather than a random value on every render, so repeated renders of an unchanged block don't thrash.

## File Changes (expected)

- `packages/app/package.json` — add `mermaid` dependency.
- `packages/app/src/editor-extensions.ts` — give `MarkdownCodeBlock` an `addNodeView()` that branches on the `language` attribute; extract a new `MermaidCodeBlockView.tsx` (or similar) component under `packages/app/src/components/` for the React node view.
- New component file(s) for the node view itself: render/source toggle, error state, theme wiring.
- `packages/app/src/markdown.test.ts` — round-trip fixtures for `language-mermaid` fences (including edge cases already burned once in this repo's history per the recent commit log: blank lines inside the fence, a fence containing backticks/code-span-like text, adjacent list items or headings around the block) to satisfy ADR 0003's "new Markdown support needs fixture coverage."
- A new component-level test file for the node view (render vs. source vs. error states, theme switch, comment-anchor-forces-source-view behavior).
- `docs/spec/ui-state-screenshot-guide.md` — add the new visual states this introduces (rendered diagram, source-editing a mermaid block, invalid-syntax error state), per this repo's standing instruction to keep that guide current with new UI states.

## Test Strategy

Per this repo's testing bar (Test Desiderata) and the Prove It / Realistic Verification workflow in `AGENTS.md`:

- **Fast, deterministic unit tests** for the parse/serialize path: a `language-mermaid` fence round-trips byte-for-byte when unrelated content changes (extends the existing `markdown.test.ts` fixture pattern). This is pure logic, no DOM, cheap to run every time.
- **Component tests** for the node view's own branching logic (rendered/source/error state transitions, comment-anchor forcing source view) — these can reasonably mock `mermaid.render()` since the behavior under test is Roughdraft's state machine, not Mermaid's rendering itself.
- **Realistic verification is required for the actual rendering boundary**, because the product behavior here is "does a real `.mermaid` diagram source actually turn into a correct, visible SVG" — a boundary-crossing concern (third-party library + real DOM), not something a mock can prove. Before calling this done:
  - Open a real Markdown file containing a mermaid fence with the local dev build (`pnpm dev` in `packages/app`, or the built `roughdraft` CLI) and visually confirm the diagram renders, that clicking it drops into editable source, that editing and blurring re-renders it, and that a deliberately broken diagram shows the inline error instead of crashing.
  - Confirm dark/light theme switching re-renders the diagram correctly.
  - Confirm a CriticMarkup comment anchored inside the mermaid source still shows up correctly (forces source view, comment rail still targets it).
- Run `pnpm check` and `pnpm test:smoke` before opening a PR per this repo's standard PR workflow.

## Risks / Open Questions

- **CriticMarkup interaction is the trickiest part.** A comment or suggestion anchored inside a diagram's source text has to remain reviewable without the rendered SVG hiding it. The "force source view when the block has an active mark" rule above is the proposed answer; needs validation against how `DocumentReviewRail.tsx`/`useCommentAnchorLayout.ts` currently locate and scroll to anchors, since those weren't inspected in depth for this plan.
- **Bundle size.** Confirm the dynamic-import approach actually keeps `mermaid` out of the initial bundle (check the Vite build output) rather than assuming it.
- **Mermaid's** `strict` **security level might reject diagram features the team already relies on** (e.g., `click` handlers used for cross-references). If so, needs a follow-up decision on `sandbox` mode or a narrower allowlist, not a silent downgrade to `loose`.
- **Performance with several diagrams in one long document** — re-render should be scoped to the changed node, not the whole document, or typing anywhere in the doc could stutter. Worth a quick check during implementation rather than assuming Tiptap's node view isolation handles it for free.

## Suggested Implementation Order

1. Add the `mermaid` dependency and confirm a bare `mermaid.render()` call works in a throwaway component (spike, not shipped) — de-risks the security/theme config before wiring it into the editor.
2. Round-trip fixture tests for `language-mermaid` fences (should already pass, given the current code path — this step is verification, not new code, per ADR 0003's fixture-first guidance).
3. Node view: rendered state only (no toggle yet), wired into `MarkdownCodeBlock`.
4. Source/edit toggle + error state.
5. Comment-anchor-forces-source-view behavior.
6. Theming.
7. Tests (component + realistic CLI verification) and `docs/spec/ui-state-screenshot-guide.md` update.
8. `pnpm check` + `pnpm test:smoke`, PR.

---
comments:
  c1:
    body: looks good, implement it
    by: user
    at: 2026-09-22T16:07:18.550Z
