import fs from "node:fs";
import path from "node:path";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { criticMarkdownToEditorState } from "./critic-markup";
import {
  splitYamlFrontmatter,
  toHtml,
  toMarkdown,
  rawMarkdownBlockAttribute,
  protectRichTextRoundTripMarkdown,
} from "./markdown";

function readMarkdownFixture(name: string): string {
  return fs.readFileSync(
    path.join(process.cwd(), "test", "fixtures", "markdown", name),
    "utf8",
  );
}

describe("splitYamlFrontmatter", () => {
  it("preserves CRLF frontmatter byte-for-byte while splitting the body", () => {
    const input = "---\r\ntitle: CRLF\r\n---\r\n\r\n# Body\r\n";

    expect(splitYamlFrontmatter(input)).toEqual({
      frontmatter: "---\r\ntitle: CRLF\r\n---\r\n\r\n",
      body: "# Body\r\n",
    });
  });

  it("preserves empty frontmatter and table-like YAML text", () => {
    const empty = "---\n---\n\n# Body\n";
    const tableLike = readMarkdownFixture("frontmatter-table-yaml.md");

    expect(splitYamlFrontmatter(empty)).toEqual({
      frontmatter: "---\n---\n\n",
      body: "# Body\n",
    });
    expect(splitYamlFrontmatter(tableLike).frontmatter).toContain(
      "  | column | value |",
    );
  });
});

describe("toHtml", () => {
  it("preserves original markdown paths while resolving rendered URLs", () => {
    const html = toHtml(
      "[Draft](notes/draft.md)\n\n![Sketch](images/sketch.png)\n\n[Docs](https://example.com)",
      {
        resolveFileUrl: (path) => `/api/files?path=${encodeURIComponent(path)}`,
      },
    );

    expect(html).toContain(
      '<a href="/api/files?path=notes%2Fdraft.md" data-markdown-src="notes/draft.md">Draft</a>',
    );
    expect(html).toContain(
      '<img src="/api/files?path=images%2Fsketch.png" alt="Sketch" data-markdown-src="images/sketch.png">',
    );
    expect(html).toContain(
      '<a href="https://example.com" data-markdown-src="https://example.com" target="_blank" rel="noreferrer noopener">Docs</a>',
    );
  });

  it("can resolve markdown document links separately from file assets", () => {
    const html = toHtml(
      "[Target](local-link-target.md)\n\n![Diagram](local-link-target.md)",
      {
        resolveFileUrl: (path) => `/api/files?path=${encodeURIComponent(path)}`,
        resolveLinkUrl: (path) =>
          path.endsWith(".md")
            ? `/?path=${encodeURIComponent(`/project/${path}`)}`
            : null,
      },
    );

    expect(html).toContain(
      '<a href="/?path=%2Fproject%2Flocal-link-target.md" data-markdown-src="local-link-target.md">Target</a>',
    );
    expect(html).toContain(
      '<img src="/api/files?path=local-link-target.md" alt="Diagram" data-markdown-src="local-link-target.md">',
    );
  });

  it("renders in-page anchors, mailto links, task lists, and table fixtures", () => {
    const html = toHtml(
      `${readMarkdownFixture("links-and-images.md")}\n${readMarkdownFixture("tables-and-task-lists.md")}`,
    );

    expect(html).toContain(
      '<a href="#links-and-images" data-markdown-src="#links-and-images">In-page anchor</a>',
    );
    expect(html).toContain(
      '<a href="mailto:review@example.com" data-markdown-src="mailto:review@example.com">Mail</a>',
    );
    expect(html).toContain('<ul data-type="taskList">');
    expect(html).toContain("<table>");
    expect(html).toContain(
      '<img src="./images/sketch.png" alt="Sketch" title="Sketch title" data-markdown-src="./images/sketch.png">',
    );
  });

  it("round-trips headerless HTML tables to valid GFM table markdown", () => {
    expect(toMarkdown(toHtml(readMarkdownFixture("headerless-table.md")))).toBe(
      [
        "# Headerless Table",
        "",
        "|     |     |",
        "| --- | --- |",
        "| First | Ready |",
        "| Second | Open |",
        "",
      ].join("\n"),
    );
  });
});

describe("normalizeBlockSpacing", () => {
  it("adds a blank line around every heading, even when the source had none", () => {
    // A ProseMirror doc has no way to know whether the source had a blank
    // line before/after a given heading, so we can't preserve that exactly.
    // Instead we always add one, matching Turndown's own heading spacing,
    // so an *existing* blank line (e.g. between a table and the next
    // heading) is never silently dropped.
    const compact = [
      "# OpenAI Chat API Compatibility Plan",
      "## Goal",
      "Build a Python/Flask service that exposes endpoints.",
      "## Source References",
      "- Codex app-server documentation",
      "- OpenAI Chat Completions overview",
      "## Key Capabilities",
      "1. First capability",
      "2. Second capability",
      "",
    ].join("\n");

    expect(toMarkdown(toHtml(compact))).toBe(
      [
        "# OpenAI Chat API Compatibility Plan",
        "",
        "## Goal",
        "",
        "Build a Python/Flask service that exposes endpoints.",
        "",
        "## Source References",
        "",
        "- Codex app-server documentation",
        "- OpenAI Chat Completions overview",
        "",
        "## Key Capabilities",
        "",
        "1. First capability",
        "2. Second capability",
        "",
      ].join("\n"),
    );
  });

  it("preserves paragraph separation", () => {
    const spaced = "First paragraph.\n\nSecond paragraph.\n";

    expect(toMarkdown(toHtml(spaced))).toBe(spaced);
  });

  it("uses dash bullet markers and compact list indentation", () => {
    const html = "<ul><li>Alpha</li><li>Beta</li></ul>";

    expect(toMarkdown(html)).toBe("- Alpha\n- Beta\n");
  });

  it("does not leave whitespace-only lines between paragraph-wrapped list items", () => {
    const html =
      "<ul><li><p>Alpha</p></li><li><p>Beta</p></li></ul><p>After</p>";

    const markdown = toMarkdown(html);

    expect(markdown).toBe("- Alpha\n- Beta\n\nAfter\n");
    for (const line of markdown.split("\n")) {
      expect(line).not.toMatch(/^\s+$/);
    }
  });

  it("indents nested list content under a paragraph-wrapped item", () => {
    const html =
      "<ul><li><p>Parent</p><ul><li><p>Nested</p></li></ul></li></ul>";

    const markdown = toMarkdown(html);

    expect(markdown).toBe("- Parent\n  - Nested\n");
  });
});

describe("thematic break round-trip", () => {
  it("preserves a --- thematic break instead of rewriting it as * * *", () => {
    const markdown = "Above.\n\n---\n\nBelow.\n";

    expect(toMarkdown(toHtml(markdown))).toBe(markdown);
  });
});

describe("table cell padding round-trip", () => {
  it("does not column-align a hand-written, unpadded header table", () => {
    const markdown = [
      "| ID | Status |",
      "| --- | --- |",
      "| R-1 | Open |",
      "",
    ].join("\n");

    expect(toMarkdown(toHtml(markdown))).toBe(markdown);
  });
});

describe("toMarkdown", () => {
  it("round-trips local links and images to normalized markdown paths", () => {
    const markdown = toMarkdown(
      '<p><a href="/api/files?path=notes%2Fdraft.md" data-markdown-src="../notes/draft.md">Draft</a></p><p><img src="/api/files?path=images%2Fsketch.png" alt="Sketch" data-markdown-src="images/sketch.png"></p>',
    );

    expect(markdown).toContain("[Draft](../notes/draft.md)");
    expect(markdown).toContain("![Sketch](./images/sketch.png)");
  });

  it("keeps in-page anchors untouched", () => {
    const markdown = toMarkdown(
      '<p><a href="#comments">Jump to comments</a></p>',
    );

    expect(markdown).toBe("[Jump to comments](#comments)\n");
  });

  it("ends output with exactly one newline", () => {
    expect(toMarkdown("<p>Done</p>\n\n")).toBe("Done\n");
  });

  it("documents the raw HTML policy for generic inline HTML and protected blocks", () => {
    expect(toMarkdown('<p><span data-x="1">raw</span></p>')).toBe("raw\n");

    const protectedMarkdown = "<!-- keep this source note -->\n";
    const encoded = encodeURIComponent(protectedMarkdown);

    expect(
      toMarkdown(`<div ${rawMarkdownBlockAttribute}="${encoded}"></div>`),
    ).toBe(protectedMarkdown);
  });
});

describe("protectRichTextRoundTripMarkdown", () => {
  it("does not wrap a table row in a raw block just because two of its cells each hold their own code span", () => {
    // Two code spans in different cells of the same row (no pipe inside
    // either span) — the gap *between* the spans crosses the real column
    // delimiter, which is not a pipe-inside-a-code-span at all.
    const markdown = [
      "| ID | A | B |",
      "| --- | --- | --- |",
      "| X-01 | `alpha` | `beta` |",
      "",
    ].join("\n");

    const protectedMarkdown = protectRichTextRoundTripMarkdown(markdown);

    expect(protectedMarkdown).not.toContain(rawMarkdownBlockAttribute);
    expect(protectedMarkdown).toBe(markdown);
  });
});

function collectNodeTypes(node: JSONContent, types: string[]): void {
  if (node.type) types.push(node.type);
  for (const child of node.content ?? []) collectNodeTypes(child, types);
}

function collectText(node: JSONContent, out: string[]): void {
  if (typeof node.text === "string") out.push(node.text);
  for (const child of node.content ?? []) collectText(child, out);
}

describe("criticMarkdownToEditorState", () => {
  it("renders a second table as a real table instead of vanishing or absorbing the next heading as raw text", () => {
    // Mirrors a real RAID log: a table row with code spans in two different
    // cells, immediately followed by another heading + table with no blank
    // line between them (parsing must not depend on that blank line being
    // present).
    const markdown = [
      "## Table One",
      "| ID | A | B |",
      "| --- | --- | --- |",
      "| X-01 | `alpha` | `beta` |",
      "## Table Two",
      "| ID | Note |",
      "| --- | --- |",
      "| X-02 | plain row, no code spans |",
      "",
    ].join("\n");

    const { doc } = criticMarkdownToEditorState(markdown);

    const types: string[] = [];
    collectNodeTypes(doc, types);
    const tableCount = types.filter((type) => type === "table").length;
    expect(tableCount).toBe(2);

    const text: string[] = [];
    collectText(doc, text);
    const joined = text.join(" ");
    // The second heading and table must render as real nodes, not as
    // literal markdown source text absorbed into a stray paragraph.
    expect(joined).not.toContain("##");
    expect(joined).not.toContain("|");
    expect(joined).toContain("Table Two");
    expect(joined).toContain("X-02");
  });
});
