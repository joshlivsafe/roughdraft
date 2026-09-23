import { describe, expect, it } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./index";

/**
 * Regression coverage for a link whose text is a code span, e.g.
 * `[`RESEARCH.md`](docs/RESEARCH.md)`. The Code mark's `excludes` list used
 * to include `link`, so ProseMirror dropped the Link mark whenever Code was
 * applied on top of it, silently turning the link into inert code text.
 *
 * A relative href like `docs/RESEARCH.md` only survives Tiptap's Link
 * parseHTML validation (`isAllowedUri`) once it's been resolved to
 * something URL-shaped, which is what the real app's `resolveLinkUrl`
 * does for same-project document links. Tests supply an equivalent
 * resolver so the link mark gets a chance to apply at all, independent of
 * the code+link exclusion behavior under test.
 */
const resolveLinkUrl = (path: string) => `http://localhost/${path}`;

describe("round-tripping a link whose text is a code span", () => {
  it("survives inside a table cell", () => {
    const input = [
      "| ID | Notes |",
      "| --- | --- |",
      "| X-01 | See [`RESEARCH.md`](docs/RESEARCH.md) for details |",
      "",
    ].join("\n");

    const { doc } = criticMarkdownToEditorState(input, { resolveLinkUrl });
    const markdown = editorStateToCriticMarkdown(doc, new Map());

    expect(markdown).toContain("[`RESEARCH.md`](./docs/RESEARCH.md)");
  });

  it("survives outside a table, as plain body text", () => {
    const input = "See [`RESEARCH.md`](docs/RESEARCH.md) for details.\n";

    const { doc } = criticMarkdownToEditorState(input, { resolveLinkUrl });
    const markdown = editorStateToCriticMarkdown(doc, new Map());

    expect(markdown).toContain("[`RESEARCH.md`](./docs/RESEARCH.md)");
  });
});
