import type { JSONContent } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createEditorExtensions } from "@/editor-extensions";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  // jsdom doesn't implement matchMedia; the node view only reads `.matches`
  // to pick a light/dark mermaid theme, so a fixed "light" stub is enough.
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

// Mounting through `useEditor` + `<EditorContent>` (rather than a bare
// `new Editor({ element })`) matters here: `ReactNodeViewRenderer` silently
// falls back to the schema's default HTML rendering when
// `editor.contentComponent` is unset, and only `<EditorContent>` sets it.
// A bare Editor instance would make every assertion below pass against the
// *default* codeBlock markup without ever exercising the mermaid node view.
function TestHarness({ content }: { content: JSONContent }) {
  const editor = useEditor({
    extensions: createEditorExtensions(""),
    content,
  });
  return <EditorContent editor={editor} />;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function mount(content: JSONContent): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  const currentRoot = createRoot(container);
  root = currentRoot;

  await act(async () => {
    currentRoot.render(<TestHarness content={content} />);
  });
  // Let the node view's own effects (mermaid render / dark-mode listener) run.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return container;
}

function getMermaidBlock(dom: HTMLElement): HTMLElement | null {
  return dom.querySelector('[data-testid="mermaid-code-block"]');
}

describe("mermaid code block node view", () => {
  it("mounts a mermaid diagram block with a preview container distinct from the plain code editor", async () => {
    const dom = await mount({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "mermaid" },
          content: [{ type: "text", text: "graph TD\n  A --> B" }],
        },
      ],
    });

    expect(getMermaidBlock(dom)).not.toBeNull();
    expect(
      dom.querySelector('[data-testid="mermaid-code-block-preview"]'),
    ).not.toBeNull();
  });

  it("falls back to the editable source and shows an inline error instead of crashing when rendering fails", async () => {
    // jsdom has no SVG layout engine (no getBBox/getComputedTextLength), so
    // `mermaid.render()` always throws here — this is jsdom's own
    // limitation, not a bug in the node view. That makes this an accidental
    // but real exercise of the error-handling path: a render failure must
    // show an inline error and keep the block editable rather than
    // crashing. Whether a *valid* diagram actually paints as SVG can only
    // be proven in a real browser (verified separately against the running
    // dev app, not here).
    const dom = await mount({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "mermaid" },
          content: [{ type: "text", text: "graph TD\n  A --> B" }],
        },
      ],
    });

    expect(getMermaidBlock(dom)?.dataset.mermaidEditing).toBe("true");
    expect(dom.textContent).toContain("Couldn't render this diagram");
    expect(dom.textContent).toContain("graph TD");
  });

  it("leaves a non-mermaid code block rendered as plain editable code", async () => {
    const dom = await mount({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "javascript" },
          content: [{ type: "text", text: "const x = 1;" }],
        },
      ],
    });

    expect(getMermaidBlock(dom)).toBeNull();
    expect(dom.textContent).toContain("const x = 1;");
  });

  it("forces source (editing) view when the mermaid block has an active comment mark", async () => {
    const dom = await mount({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "mermaid" },
          content: [
            {
              type: "text",
              text: "graph TD\n  A --> B",
              marks: [{ type: "commentRef", attrs: { commentIds: ["c1"] } }],
            },
          ],
        },
      ],
    });

    expect(getMermaidBlock(dom)?.dataset.mermaidEditing).toBe("true");
    // The plain code editor stays visible so the comment anchor is reachable.
    expect(dom.textContent).toContain("graph TD");
    // No "Edit source" affordance — there's nothing to switch away from.
    expect(dom.textContent).not.toContain("Edit source");
  });

  it("starts in editing view for an empty mermaid block instead of rendering nothing", async () => {
    const dom = await mount({
      type: "doc",
      content: [{ type: "codeBlock", attrs: { language: "mermaid" } }],
    });

    expect(getMermaidBlock(dom)?.dataset.mermaidEditing).toBe("true");
  });
});
