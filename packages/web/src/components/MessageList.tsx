import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism/index.js";
import type { ChatMessage } from "@cc-pet/shared";
import { useRef, useEffect } from "react";

interface Props {
  messages: ChatMessage[];
  streamingContent?: string;
}

export function MessageList({ messages, streamingContent }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      {streamingContent && (
        <MessageBubble
          message={{ id: "streaming", role: "assistant", content: streamingContent, timestamp: Date.now() }}
        />
      )}
      <div ref={bottomRef} />
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 ${
          isUser ? "bg-accent/20 text-blue-100" : "bg-surface-tertiary text-gray-200"
        }`}
      >
        <div className="text-[10px] text-gray-500 mb-1">{isUser ? "you" : "bot"}</div>
        <div className="prose prose-invert prose-sm max-w-none">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={{
              code({ className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || "");
                const code = String(children).replace(/\n$/, "");
                if (match) {
                  return <SyntaxHighlighter style={oneDark} language={match[1]} PreTag="div">{code}</SyntaxHighlighter>;
                }
                return <code className="bg-surface-tertiary px-1 rounded" {...props}>{children}</code>;
              },
            }}
          >
            {message.content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
