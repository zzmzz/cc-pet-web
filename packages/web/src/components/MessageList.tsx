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
    <div className="flex-1 min-h-0 overflow-y-auto py-3 space-y-1">
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
  const hasFiles = Array.isArray(message.files) && message.files.length > 0;

  if (hasFiles) {
    const caption = message.content.trim();
    return (
      <div className={`flex ${isUser ? "justify-end" : "justify-start"} px-3 py-1`}>
        <div
          className={`${
            isUser
              ? "bg-blue-50 border-blue-200 text-blue-700"
              : "bg-green-50 border-green-200 text-green-700"
          } border rounded-lg px-3 py-2 text-sm max-w-[80%]`}
        >
          {caption ? <div className="mb-1.5 whitespace-pre-wrap break-words">{caption}</div> : null}
          <div className="space-y-1">
            {(message.files ?? []).map((file) => (
              <div key={file.id} className="flex items-center gap-2 min-w-0">
                <span className="shrink-0">{isUser ? "📎" : "📥"}</span>
                <span className="truncate">{file.name}</span>
              </div>
            ))}
          </div>
          <div className={`text-[10px] mt-1 ${isUser ? "text-blue-400" : "text-green-500"}`}>
            {new Date(message.timestamp).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} px-3 py-1`}>
      <div
        className={`max-w-[85%] min-w-0 overflow-hidden rounded-2xl px-4 py-2.5 text-[13.5px] leading-relaxed ${
          isUser
            ? "bg-indigo-500 text-white rounded-br-md"
            : "bg-gray-100 text-gray-800 rounded-bl-md markdown-body"
        }`}
      >
        <div className="break-words">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={{
              code({ className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || "");
                const code = String(children).replace(/\n$/, "");
                if (match) {
                  return (
                    <SyntaxHighlighter
                      style={oneDark}
                      language={match[1]}
                      PreTag="div"
                      wrapLongLines
                      customStyle={{
                        borderRadius: "8px",
                        margin: 0,
                        fontSize: "12.5px",
                      }}
                    >
                      {code}
                    </SyntaxHighlighter>
                  );
                }
                return (
                  <code
                    className={`px-1.5 py-0.5 rounded text-[0.9em] ${
                      isUser ? "bg-indigo-400/40 text-indigo-50" : "bg-slate-100 text-rose-600"
                    }`}
                    {...props}
                  >
                    {children}
                  </code>
                );
              },
            }}
          >
            {isUser ? message.content : message.content.replace(/\n/g, "  \n")}
          </ReactMarkdown>
        </div>
        <div className={`text-[10px] mt-1 ${isUser ? "text-indigo-200" : "text-gray-400"}`}>
          {new Date(message.timestamp).toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
      </div>
    </div>
  );
}
