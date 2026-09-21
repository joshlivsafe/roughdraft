import { tables, taskListItems } from "@joplin/turndown-plugin-gfm";
import { marked } from "marked";
import TurndownService from "turndown";
import { parse as parseYaml } from "yaml";

export const rawMarkdownBlockAttribute = "data-markdown-raw-block";

export interface MarkdownOptions {
  resolveFileUrl?: (path: string) => string | null;
  resolveLinkUrl?: (path: string) => string | null;
}

export interface YamlFrontmatterSplit {
  frontmatter: string | null;
  body: string;
}

export interface YamlDocumentMetadataSplit {
  frontmatter: string | null;
  body: string;
  endmatter: string | null;
}

function isExternalUrl(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//");
}

function isInPageAnchor(path: string): boolean {
  return path.startsWith("#");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function encodeRawMarkdownBlock(markdown: string): string {
  return encodeURIComponent(markdown);
}

export function decodeRawMarkdownBlock(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function createRawMarkdownBlock(markdown: string): string {
  // The trailing blank line is load-bearing: a CommonMark HTML block only
  // terminates on a blank line, so without it any content immediately
  // following (e.g. a heading with no blank line before it) gets absorbed
  // into this block as inert raw text instead of being parsed normally.
  return `<div ${rawMarkdownBlockAttribute}="${escapeHtml(
    encodeRawMarkdownBlock(markdown),
  )}"></div>\n\n`;
}

function protectRawHtmlBlocks(markdown: string): string {
  return markdown
    .replace(
      /^[ \t]*<details\b[\s\S]*?<\/details>[ \t]*(?:\r?\n|$)/gim,
      (raw) => createRawMarkdownBlock(raw),
    )
    .replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*(?:\r?\n|$)/gm, (raw) =>
      createRawMarkdownBlock(raw),
    );
}

function protectIndentedCodeAfterLists(markdown: string): string {
  return markdown.replace(
    /^(?:[-*+]|\d+[.)]) [^\r\n]*(?:\r?\n)[ \t]*(?:\r?\n)(?:(?: {4}|\t)[^\r\n]*(?:\r?\n|$))+/gm,
    (raw) => createRawMarkdownBlock(raw),
  );
}

function lineHasPipeInsideCodeSpan(line: string): boolean {
  // Split on backtick delimiters and pair them left-to-right: parts[1],
  // parts[3], parts[5], ... are the text *inside* a matched code span. A
  // naive `` `[^`]*\|[^`]*` `` scan instead re-tries a match starting from
  // every backtick, including a closing backtick of one span paired with
  // the opening backtick of a later, unrelated span on the same line — and
  // if a real column-delimiter pipe falls between those two spans, that
  // false pairing reports a pipe "inside" a code span that doesn't exist.
  const parts = line.split("`");
  const backtickCount = parts.length - 1;
  const matchedSpanCount = Math.floor(backtickCount / 2);

  for (let spanIndex = 0; spanIndex < matchedSpanCount; spanIndex += 1) {
    const insidePart = parts[spanIndex * 2 + 1] ?? "";
    if (insidePart.includes("|")) {
      return true;
    }
  }

  return false;
}

function rowNeedsPipeProtection(row: string): boolean {
  return row.includes("\\|") || lineHasPipeInsideCodeSpan(row);
}

function protectPipeSensitiveTables(markdown: string): string {
  const lines = markdown.match(/[^\r\n]*(?:\r?\n|$)/g) ?? [];
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1] ?? "";

    if (
      !line.includes("|") ||
      !/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(nextLine)
    ) {
      output.push(line);
      continue;
    }

    const tableLines = [line, nextLine];
    index += 2;

    while (index < lines.length) {
      const row = lines[index] ?? "";
      if (!row.trim() || !row.includes("|")) break;
      tableLines.push(row);
      index += 1;
    }

    const needsProtection = tableLines.some((row) =>
      rowNeedsPipeProtection(row),
    );
    output.push(
      needsProtection
        ? createRawMarkdownBlock(tableLines.join(""))
        : tableLines.join(""),
    );
    index -= 1;
  }

  return output.join("");
}

export function protectRichTextRoundTripMarkdown(markdown: string): string {
  return protectPipeSensitiveTables(
    protectIndentedCodeAfterLists(protectRawHtmlBlocks(markdown)),
  );
}

function normalizeMarkdownPath(path: string): string {
  if (path.startsWith("./") || path.startsWith("../")) return path;
  return `./${path.replace(/^\/+/, "")}`;
}

function tableHasUnsupportedMarkdownContent(table: HTMLTableElement): boolean {
  return Boolean(
    table.querySelector(
      "blockquote, h1, h2, h3, h4, h5, h6, hr, ol, pre, table, ul",
    ),
  );
}

function getFirstTableRow(table: HTMLTableElement): HTMLTableRowElement | null {
  return table.rows.length > 0 ? table.rows[0] : null;
}

function isHeaderTableRow(row: HTMLTableRowElement | null): boolean {
  if (!row || row.cells.length === 0) return false;

  return Array.from(row.cells).every((cell) => cell.tagName === "TH");
}

function isMarkdownTableDivider(line: string | undefined): boolean {
  return Boolean(line && /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line));
}

function markdownTableDividerForCell(cell: HTMLTableCellElement): string {
  const alignment = (
    cell.getAttribute("align") ||
    cell.style.textAlign ||
    ""
  ).toLowerCase();

  if (alignment === "left") return ":---";
  if (alignment === "right") return "---:";
  if (alignment === "center") return ":---:";

  return "---";
}

function markdownTableDividerForRow(row: HTMLTableRowElement): string {
  const dividers = Array.from(row.cells).map(markdownTableDividerForCell);
  return `| ${dividers.join(" | ")} |`;
}

function resolveRenderedUrl(
  path: string,
  resolveFileUrl?: MarkdownOptions["resolveFileUrl"],
) {
  if (isExternalUrl(path) || isInPageAnchor(path)) return path;
  return resolveFileUrl?.(path) ?? path;
}

function isYamlFrontmatterDelimiter(line: string): boolean {
  return /^(?:---|\.\.\.)[ \t]*$/.test(line.replace(/\r$/, ""));
}

function isReviewEndmatterMap(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasDocumentLevelComment(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  return Object.values(value as Record<string, unknown>).some(
    (entry) =>
      Boolean(entry) &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof (entry as Record<string, unknown>).body === "string" &&
      typeof (entry as Record<string, unknown>).by === "string" &&
      typeof (entry as Record<string, unknown>).at === "string" &&
      typeof (entry as Record<string, unknown>).re !== "string",
  );
}

function isRoughdraftReviewEndmatter(endmatter: string): boolean {
  const yamlText = endmatter.replace(/^---[ \t]*(?:\r\n|\n)/, "");
  let parsed: unknown;

  try {
    parsed = parseYaml(yamlText);
  } catch {
    return false;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }

  const record = parsed as Record<string, unknown>;
  return (
    isReviewEndmatterMap(record.comments) ||
    isReviewEndmatterMap(record.suggestions)
  );
}

export function splitYamlFrontmatter(markdown: string): YamlFrontmatterSplit {
  const openingDelimiter = markdown.match(/^---[ \t]*(?:\r\n|\n)/);
  if (!openingDelimiter) return { frontmatter: null, body: markdown };

  let lineStart = openingDelimiter[0].length;

  while (lineStart < markdown.length) {
    const nextLineBreak = markdown.indexOf("\n", lineStart);
    const lineEnd = nextLineBreak === -1 ? markdown.length : nextLineBreak + 1;
    const line = markdown.slice(
      lineStart,
      nextLineBreak === -1 ? lineEnd : lineEnd - 1,
    );

    if (isYamlFrontmatterDelimiter(line)) {
      let bodyStart = lineEnd;

      while (bodyStart < markdown.length) {
        const blankLineBreak = markdown.indexOf("\n", bodyStart);
        const blankLineEnd =
          blankLineBreak === -1 ? markdown.length : blankLineBreak + 1;
        const blankLine = markdown.slice(
          bodyStart,
          blankLineBreak === -1 ? blankLineEnd : blankLineEnd - 1,
        );

        if (blankLine.replace(/\r$/, "").trim() !== "") break;
        bodyStart = blankLineEnd;
      }

      return {
        frontmatter: markdown.slice(0, bodyStart),
        body: markdown.slice(bodyStart),
      };
    }

    lineStart = lineEnd;
  }

  return { frontmatter: null, body: markdown };
}

export function prependYamlFrontmatter(
  markdown: string,
  frontmatter?: string | null,
): string {
  return frontmatter ? `${frontmatter}${markdown}` : markdown;
}

export function splitYamlDocumentMetadata(
  markdown: string,
): YamlDocumentMetadataSplit {
  const { frontmatter, body } = splitYamlFrontmatter(markdown);
  const matches = [...body.matchAll(/\n---[ \t]*\r?\n/g)];
  const match = matches.at(-1);

  if (!match || match.index === undefined) {
    return { frontmatter, body, endmatter: null };
  }

  const endmatter = body.slice(match.index);
  const candidate = endmatter.replace(/^\n/, "");

  const precedingBody = body.slice(0, match.index);
  if (!isRoughdraftReviewEndmatter(candidate)) {
    return { frontmatter, body, endmatter: null };
  }
  if (!precedingBody.includes("{#")) {
    const yamlText = candidate.replace(/^---[ \t]*(?:\r\n|\n)/, "");
    const parsed = parseYaml(yamlText) as Record<string, unknown> | null;
    if (!hasDocumentLevelComment(parsed?.comments)) {
      return { frontmatter, body, endmatter: null };
    }
  }

  return {
    frontmatter,
    body: body.slice(0, match.index).replace(/\s*$/, "\n"),
    endmatter: candidate,
  };
}

export function appendYamlEndmatter(
  markdown: string,
  endmatter?: string | null,
): string {
  return endmatter
    ? `${markdown.replace(/\s*$/, "\n")}\n${endmatter}`
    : markdown;
}

export function createMarkedRenderer(options?: MarkdownOptions) {
  const renderer = new marked.Renderer();
  const baseRenderer = new marked.Renderer();
  const resolveFileUrl = options?.resolveFileUrl;
  const resolveLinkUrl = options?.resolveLinkUrl;

  renderer.code = ({ text, lang, escaped }) => {
    const language = (lang || "").match(/\S+/)?.[0];
    const content = escaped ? text : escapeHtml(text);
    const classAttr = language
      ? ` class="language-${escapeHtml(language)}"`
      : "";

    return `<pre><code${classAttr}>${content}</code></pre>\n`;
  };

  renderer.link = function ({ href, title, tokens, raw }) {
    const rawHref = href || "";
    const renderedHref = resolveRenderedUrl(
      rawHref,
      (path) => resolveLinkUrl?.(path) ?? resolveFileUrl?.(path) ?? null,
    );
    const text = this.parser.parseInline(tokens);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    const markdownSrcAttr = ` data-markdown-src="${escapeHtml(rawHref)}"`;
    const autolinkAttr =
      !title && raw?.startsWith("<") && raw.endsWith(">")
        ? ' data-markdown-autolink="true"'
        : "";
    const externalAttr =
      isExternalUrl(rawHref) && !rawHref.startsWith("mailto:")
        ? ' target="_blank" rel="noreferrer noopener"'
        : "";

    return `<a href="${escapeHtml(renderedHref)}"${titleAttr}${markdownSrcAttr}${autolinkAttr}${externalAttr}>${text}</a>`;
  };

  renderer.image = ({ href, title, text }) => {
    const rawHref = href || "";
    const renderedHref = resolveRenderedUrl(rawHref, resolveFileUrl);
    const alt = text || "";
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    const markdownSrcAttr = ` data-markdown-src="${escapeHtml(rawHref)}"`;

    return `<img src="${escapeHtml(renderedHref)}" alt="${escapeHtml(alt)}"${titleAttr}${markdownSrcAttr}>`;
  };

  renderer.list = function (token) {
    const hasTaskItems = token.items.some((item) => item.task);
    if (!hasTaskItems) {
      return baseRenderer.list.call(this, token);
    }

    const items = token.items
      .map((item) => {
        const checked = item.checked ? "true" : "false";
        const inner = this.parser.parse(item.tokens, false);
        return `<li data-type="taskItem" data-checked="${checked}"><label><input type="checkbox"${
          item.checked ? ' checked="checked"' : ""
        }><span></span></label><div>${inner}</div></li>`;
      })
      .join("");

    return `<ul data-type="taskList">${items}</ul>`;
  };

  return renderer;
}

export function createTurndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    blankReplacement(_content, node) {
      if (node.hasAttribute(rawMarkdownBlockAttribute)) {
        return `\n\n${decodeRawMarkdownBlock(
          node.getAttribute(rawMarkdownBlockAttribute) ?? "",
        ).trimEnd()}\n\n`;
      }

      return (node as HTMLElement & { isBlock?: boolean }).isBlock
        ? "\n\n"
        : "";
    },
  });

  service.use(tables as Parameters<TurndownService["use"]>[0]);
  service.use(taskListItems as Parameters<TurndownService["use"]>[0]);

  service.addRule("compactListItem", {
    filter: "li",
    replacement(content, node, options) {
      const trimmed = content
        .replace(/\n{2,}/g, "\n")
        .replace(/^\n+/, "")
        .replace(/\n+$/, "\n")
        .replace(/\n(?!$)/g, "\n  ");

      let prefix = `${options.bulletListMarker} `;
      const parent = node.parentNode;
      if (parent && parent.nodeName === "OL") {
        const start = (parent as HTMLOListElement).getAttribute("start");
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start ? Number(start) + index : index + 1}. `;
      }

      return (
        prefix +
        trimmed +
        (node.nextSibling && !/\n$/.test(trimmed) ? "\n" : "")
      );
    },
  });

  service.addRule("tiptapHeaderTable", {
    filter(node) {
      if (node.tagName !== "TABLE") return false;

      const table = node as HTMLTableElement;
      return (
        !tableHasUnsupportedMarkdownContent(table) &&
        isHeaderTableRow(getFirstTableRow(table))
      );
    },
    replacement(content, node) {
      const table = node as HTMLTableElement;
      const headerRow = getFirstTableRow(table);
      if (!headerRow) return content;

      const lines = content
        .replace(/\n+/g, "\n")
        .trim()
        .split("\n")
        // The GFM tables plugin pads each cell to a minimum width of 3
        // characters (unrelated to other rows' widths); collapse that
        // back down to single-space cell padding so a hand-written,
        // unaligned table round-trips without column-alignment diff noise.
        .map((line) => line.replace(/ {2,}\|/g, " |"));
      if (lines.length === 0) return content;

      if (!isMarkdownTableDivider(lines[1])) {
        lines.splice(1, 0, markdownTableDividerForRow(headerRow));
      }

      const captionContent = table.caption?.textContent || "";
      const caption = captionContent ? `${captionContent}\n\n` : "";

      return `\n\n${caption}${lines.join("\n")}\n\n`;
    },
  });

  service.addRule("thematicBreak", {
    filter: "hr",
    replacement() {
      return "\n\n---\n\n";
    },
  });

  // We own the markdown parser and want stable round-trips without doubled escapes.
  service.escape = (value: string) => value;

  service.addRule("markdownAwareLinks", {
    filter: "a",
    replacement(content, node) {
      const element = node as HTMLAnchorElement;
      const href =
        element.getAttribute("data-markdown-src") ||
        element.getAttribute("href") ||
        "";
      const normalizedHref =
        isExternalUrl(href) || isInPageAnchor(href)
          ? href
          : normalizeMarkdownPath(href);
      const title = element.getAttribute("title");
      const titleMarkdown = title
        ? ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
        : "";

      if (
        element.getAttribute("data-markdown-autolink") === "true" &&
        !titleMarkdown
      ) {
        return href.startsWith("mailto:")
          ? `<${href.slice("mailto:".length)}>`
          : `<${normalizedHref}>`;
      }

      return `[${content}](${normalizedHref}${titleMarkdown})`;
    },
  });

  service.addRule("markdownAwareImages", {
    filter: "img",
    replacement(_content, node) {
      const element = node as HTMLImageElement;
      const src =
        element.getAttribute("data-markdown-src") ||
        element.getAttribute("src") ||
        "";
      const normalizedSrc = isExternalUrl(src)
        ? src
        : normalizeMarkdownPath(src);
      const alt = element.getAttribute("alt") || "";
      const title = element.getAttribute("title");
      const titleMarkdown = title
        ? ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
        : "";
      return `![${alt}](${normalizedSrc}${titleMarkdown})`;
    },
  });

  service.addRule("markdownStrikethrough", {
    filter: (node) =>
      node.nodeName === "DEL" ||
      node.nodeName === "S" ||
      node.nodeName === "STRIKE",
    replacement(content) {
      return `~~${content}~~`;
    },
  });

  service.addRule("rawMarkdownBlock", {
    filter: (node) =>
      node.nodeType === 1 &&
      (node as HTMLElement).hasAttribute(rawMarkdownBlockAttribute),
    replacement(_content, node) {
      const encoded =
        (node as HTMLElement).getAttribute(rawMarkdownBlockAttribute) ?? "";
      return `\n\n${decodeRawMarkdownBlock(encoded).trimEnd()}\n\n`;
    },
  });

  return service;
}

const turndown = createTurndownService();

/**
 * Collapse runs of 3+ newlines to 2. A ProseMirror document has no concept
 * of "was there a blank line here in the source", so headings keep
 * Turndown's own blank line before/after them rather than having it
 * stripped — stripping it was indistinguishable from deleting a blank line
 * the user actually wrote, which is exactly the corruption this guards
 * against now.
 */
export function normalizeBlockSpacing(md: string): string {
  return md.replace(/\n{3,}/g, "\n\n");
}

export function toMarkdown(html: string): string {
  return normalizeBlockSpacing(`${turndown.turndown(html).trimEnd()}\n`);
}

export function toHtml(markdown: string, options?: MarkdownOptions): string {
  return marked.parse(markdown, {
    async: false,
    gfm: true,
    renderer: createMarkedRenderer(options),
  }) as string;
}
