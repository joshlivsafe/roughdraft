import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  NodeViewContent,
  NodeViewWrapper,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { Pencil } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;

function loadMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("mermaid").then((module) => {
      module.default.initialize({
        startOnLoad: false,
        // A mermaid fence can come from a file opened from disk, or (per
        // ADR 0004's remote-document mode) one registered from another
        // machine over the network — treat its source as untrusted and
        // disable directives (`click`, HTML labels) that could otherwise
        // execute script or inject markup into the editor's origin.
        securityLevel: "strict",
        theme: prefersDarkTheme() ? "dark" : "default",
      });
      return module;
    });
  }
  return mermaidModulePromise;
}

function prefersDarkTheme(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function hasReviewMarks(node: ProseMirrorNode): boolean {
  let found = false;
  node.content.forEach((child) => {
    if (
      child.marks.some(
        (mark) =>
          mark.type.name === "commentRef" || mark.type.name === "criticChange",
      )
    ) {
      found = true;
    }
  });
  return found;
}

export function MermaidCodeBlockView(props: ReactNodeViewProps) {
  const { node, editor, getPos } = props;
  const instanceId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const source = node.textContent;
  const forcedSourceView = hasReviewMarks(node);
  const [isEditing, setIsEditing] = useState(
    forcedSourceView || source.trim() === "",
  );
  const [error, setError] = useState<string | null>(null);
  const [darkTheme, setDarkTheme] = useState(prefersDarkTheme);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setDarkTheme(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (forcedSourceView) setIsEditing(true);
  }, [forcedSourceView]);

  useEffect(() => {
    if (isEditing) return;
    if (source.trim() === "") return;

    let cancelled = false;
    const container = containerRef.current;

    loadMermaid()
      .then(async (module) => {
        module.default.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: darkTheme ? "dark" : "default",
        });
        const { svg } = await module.default.render(
          `mermaid-${instanceId}`,
          source,
        );
        if (cancelled || !container) return;
        container.innerHTML = svg;
        setError(null);
      })
      .catch((renderError: unknown) => {
        if (cancelled) return;
        setError(
          renderError instanceof Error
            ? renderError.message
            : "Failed to render diagram.",
        );
        setIsEditing(true);
      });

    return () => {
      cancelled = true;
    };
  }, [isEditing, source, darkTheme, instanceId]);

  const enterEditMode = () => {
    setIsEditing(true);
    const pos = getPos();
    if (typeof pos === "number") {
      editor
        .chain()
        .focus()
        .setTextSelection(pos + 1)
        .run();
    }
  };

  return (
    <NodeViewWrapper
      className="mermaid-code-block my-[1.35em] overflow-hidden rounded-2xl border border-[var(--code-block-border)]"
      data-testid="mermaid-code-block"
      data-mermaid-editing={isEditing}
    >
      <div
        className="flex items-center justify-between border-b border-[var(--code-block-border)] bg-[var(--code-block-background)] px-3 py-1.5 text-[0.7rem] font-medium tracking-[0.02em] text-stone-500 uppercase dark:text-slate-400"
        contentEditable={false}
      >
        <span>Mermaid diagram</span>
        {!isEditing && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={enterEditMode}
          >
            <Pencil data-icon="inline-start" />
            Edit source
          </Button>
        )}
        {isEditing && !forcedSourceView && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={source.trim() === ""}
            onClick={() => setIsEditing(false)}
          >
            Preview
          </Button>
        )}
      </div>

      {error && (
        <div
          className="border-b border-[var(--code-block-border)] bg-red-50 px-4 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300"
          contentEditable={false}
        >
          Couldn't render this diagram: {error}
        </div>
      )}

      <pre
        className="overflow-x-auto bg-[var(--code-block-background)] p-4 text-[var(--code-block-foreground)]"
        style={{ display: isEditing ? "block" : "none" }}
      >
        <NodeViewContent<"code"> as="code" />
      </pre>

      <div
        ref={containerRef}
        className="mermaid-code-block-preview flex justify-center bg-[var(--code-block-background)] p-4"
        data-testid="mermaid-code-block-preview"
        style={{ display: isEditing ? "none" : "block" }}
        contentEditable={false}
      />
    </NodeViewWrapper>
  );
}
