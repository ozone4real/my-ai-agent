import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders model output, which is markdown.
 *
 * No `rehype-raw`: react-markdown ignores embedded HTML by default, and that is
 * the property worth keeping — this text comes from a model that has just read
 * arbitrary web pages, so treating it as trusted markup would be an injection
 * route straight into the page.
 *
 * remark-gfm adds the parts models actually emit: tables, strikethrough, task
 * lists and bare URLs.
 */
export default function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Model-supplied links are untrusted: open them away from the app and
          // deny access to window.opener.
          a: (props) => <a {...props} target="_blank" rel="noopener noreferrer nofollow" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
