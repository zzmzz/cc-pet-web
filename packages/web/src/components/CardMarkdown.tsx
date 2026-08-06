import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

/**
 * Markdown body shared by chat cards. Line breaks come from remark-breaks, so the
 * container must NOT use whitespace-pre-wrap: markdown emits a real "\n" right after
 * each <br>, which pre-wrap would render as a second line break.
 */
export function CardMarkdown({ content }: { content: string }) {
  return (
    <div className="text-sm text-gray-800 break-words markdown-body card-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{content}</ReactMarkdown>
    </div>
  );
}
