import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import {
  createCriticComment,
  editorStateToCriticMarkdown,
  type CriticComment,
} from "./index";

/**
 * Regression coverage for a code block (e.g. a mermaid diagram) that has a
 * review comment anchored to part of its content. Serializing that code
 * block used to route its inner HTML through a general-purpose turndown
 * pass that collapses whitespace outside `<pre>`/`<code>` boundaries,
 * flattening every newline in the code/diagram source to a single space.
 */
describe("editorStateToCriticMarkdown / code block with an anchored comment", () => {
  function buildDoc(): JSONContent {
    return {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "mermaid" },
          content: [
            { type: "text", text: "graph TD\nA --> B\n" },
            {
              type: "text",
              text: "C --> D",
              marks: [{ type: "commentRef", attrs: { commentIds: ["c1"] } }],
            },
            { type: "text", text: "\nE --> F" },
          ],
        },
      ],
    };
  }

  function buildComments(): Map<string, CriticComment> {
    const comment = createCriticComment({ content: "why this edge?" });
    return new Map([[comment.id, comment]]);
  }

  it("preserves newlines in the fenced code block instead of flattening it to one line", () => {
    const markdown = editorStateToCriticMarkdown(buildDoc(), buildComments());

    const fenceMatch = markdown.match(/```mermaid\n([\s\S]*?)```/);
    expect(fenceMatch).toBeTruthy();
    const body = fenceMatch?.[1] ?? "";
    const lines = body.trimEnd().split("\n");

    // Each original source line must survive as its own line: flattening
    // collapses all of this to one line joined by spaces instead.
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("graph TD");
    expect(lines[1]).toBe("A --> B");
    expect(lines[2]).toMatch(
      /^\{==C --> D==\}\{>>why this edge\?<<\}\{id="c1" by="user" at="[^"]+"\}$/,
    );
    expect(lines[3]).toBe("E --> F");
  });

  it("still round-trips a plain code block with no comment (no regression)", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "mermaid" },
          content: [{ type: "text", text: "graph TD\nA --> B\nC --> D" }],
        },
      ],
    };

    const markdown = editorStateToCriticMarkdown(doc, new Map());
    const fenceMatch = markdown.match(/```mermaid\n([\s\S]*?)```/);
    expect(fenceMatch).toBeTruthy();
    expect(fenceMatch?.[1]).toBe("graph TD\nA --> B\nC --> D\n");
  });
});
