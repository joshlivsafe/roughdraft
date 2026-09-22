import {
  NodeViewContent,
  NodeViewWrapper,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { MermaidCodeBlockView } from "@/components/MermaidCodeBlockView";

const codeBlockLanguageClassPrefix = "language-";

function PlainCodeBlockView(props: ReactNodeViewProps) {
  const language = props.node.attrs.language as string | null;
  return (
    <NodeViewWrapper as="pre">
      <NodeViewContent<"code">
        as="code"
        className={
          language ? `${codeBlockLanguageClassPrefix}${language}` : undefined
        }
      />
    </NodeViewWrapper>
  );
}

export function CodeBlockView(props: ReactNodeViewProps) {
  return props.node.attrs.language === "mermaid" ? (
    <MermaidCodeBlockView {...props} />
  ) : (
    <PlainCodeBlockView {...props} />
  );
}
