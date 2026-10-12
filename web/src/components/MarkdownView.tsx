import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// This whole module is behind a lazy import (see FilesView), so the parser and
// its plugins are a chunk of their own: most files in a configuration
// repository are not markdown, and nobody should download a markdown parser to
// look at a values file. Whether a path IS markdown is answered by
// monacoLang.isMarkdown, which costs nothing to import.

// MarkdownView renders a repository's prose as prose. The content is somebody
// else's file, so raw HTML in it is NOT rendered - react-markdown escapes it
// unless a rehype-raw plugin is added, and none is: a README is a document to
// read, never a place for a document to run something.
//
// Links open in a new tab and carry noopener, for the same reason.
// The theme comes from the same tokens as everything else, so there is nothing
// to pass in about light or dark.
export default function MarkdownView({ content }: { content: string }) {
  const plugins = useMemo(() => [remarkGfm], []);
  return (
    <div className="cf-md">
      <ReactMarkdown
        remarkPlugins={plugins}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
