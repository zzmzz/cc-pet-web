import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism/index.js";
import type { ChatMessage } from "@cc-pet/shared";
import type { ReactNode } from "react";
import { useRef, useEffect, useCallback, useState, useMemo, memo } from "react";
import { getPlatform } from "../lib/platform.js";
import { groupMessages } from "../lib/group-messages.js";
import { ActivityBlock } from "./ActivityBlock.js";
import { CardMessage } from "./CardMessage.js";
import { AudioMessage } from "./AudioMessage.js";

function formatMessageTime(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (msgDay.getTime() === today.getTime()) return time;
  if (msgDay.getTime() === yesterday.getTime()) return `昨天 ${time}`;
  if (now.getFullYear() === date.getFullYear()) {
    return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

interface PreviewEntry {
  previewId: string;
  content: string;
}

interface Props {
  messages: ChatMessage[];
  streamingContent?: string;
  sessionKey?: string;
  previews?: PreviewEntry[];
}

interface LinkPreviewData {
  url: string;
  finalUrl?: string;
  title?: string;
  description?: string;
  image?: string;
  isFile?: boolean;
  fileName?: string;
  contentType?: string;
}

const LINK_PREVIEW_CACHE = new Map<string, LinkPreviewData | null>();
const LINK_PREVIEW_INFLIGHT = new Map<string, Promise<LinkPreviewData | null>>();
const IMAGE_LINK_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);
const FILE_LINK_EXTS = new Set([
  "zip", "rar", "7z", "tar", "gz", "bz2",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "mp3", "wav",
  "apk", "exe", "dmg", "msi",
]);

function parseUrl(href?: string): URL | null {
  const normalized = normalizeHref(href);
  if (!normalized) return null;
  try {
    return new URL(normalized);
  } catch {
    return null;
  }
}

function normalizeHref(href?: string): string {
  if (!href) return "";
  const trimmed = href.trim().replace(/(?:%20)+$/gi, "");
  if (!trimmed) return "";
  return splitUrlTrailingNote(trimmed)?.url ?? trimmed;
}

function normalizeLinkDisplayText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([（(\[【《])/g, "$1")
    .replace(/([（(\[【《])\s+/g, "$1")
    .replace(/\s+([）)\]】》])/g, "$1")
    .trim();
}

function splitUrlTrailingNote(text: string): { url: string; note: string } | null {
  if (!text.startsWith("http")) return null;
  if (!text.endsWith("）")) return null;
  const idx = text.lastIndexOf("（");
  if (idx <= 0) return null;
  const urlPart = text.slice(0, idx);
  const note = text.slice(idx);
  if (note.length > 40) return null;
  if (!parseUrl(urlPart)) return null;
  return { url: urlPart, note };
}

function getNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) return node.map((item) => getNodeText(item)).join("");
  if (typeof node === "object" && "props" in node) {
    const el = node as { props?: { children?: ReactNode } };
    return getNodeText(el.props?.children);
  }
  return "";
}

function getReadablePath(url: URL): string {
  const pathname = normalizeLinkDisplayText(decodeURIComponent(url.pathname || "/"));
  if (!pathname || pathname === "/") return "";
  if (pathname.length <= 28) return pathname;
  return `${pathname.slice(0, 25)}...`;
}

function getReadableLinkTitle(url: URL): string {
  const host = url.hostname.replace(/^www\./, "");
  const pathname = decodeURIComponent(url.pathname || "");
  if (!pathname || pathname === "/") return host;
  const last = pathname.split("/").filter(Boolean).pop() || "";
  const fromLast = normalizeLinkDisplayText(last.replace(/[-_]+/g, " "));
  if (fromLast) return fromLast;
  return `${host}${getReadablePath(url)}`;
}

function getFaviconUrl(url: URL): string {
  return `${url.origin}/favicon.ico`;
}

function isFileLikeLink(url: URL): boolean {
  const path = url.pathname || "";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (FILE_LINK_EXTS.has(ext)) return true;
  const q = url.search.toLowerCase();
  return q.includes("download=") || q.includes("filename=");
}

function isImageLink(url: URL, contentType?: string): boolean {
  if (contentType?.startsWith("image/")) return true;
  const ext = url.pathname.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_LINK_EXTS.has(ext);
}

function getDisplayFileName(url: URL): string {
  const seg = decodeURIComponent(url.pathname.split("/").pop() || "").trim();
  if (seg) return seg;
  const filename = url.searchParams.get("filename");
  if (filename) return filename;
  return "下载文件";
}

async function loadLinkPreview(url: string): Promise<LinkPreviewData | null> {
  if (LINK_PREVIEW_CACHE.has(url)) {
    return LINK_PREVIEW_CACHE.get(url) ?? null;
  }
  const existing = LINK_PREVIEW_INFLIGHT.get(url);
  if (existing) return existing;
  const task = Promise.resolve()
    .then(async () => {
      try {
        // Prefer platform adapter to include auth token automatically.
        return await getPlatform().fetchApi<LinkPreviewData | { error: string }>(
          `/api/link-preview?url=${encodeURIComponent(url)}`,
          { method: "GET" },
        );
      } catch {
        const res = await fetch(`/api/link-preview?url=${encodeURIComponent(url)}`, { method: "GET" });
        if (!res.ok) return null;
        return (await res.json()) as LinkPreviewData | { error: string };
      }
    })
    .then((payload) => {
      if (!payload || typeof payload !== "object" || "error" in payload) return null;
      return payload as LinkPreviewData;
    })
    .then((data) => {
      LINK_PREVIEW_CACHE.set(url, data);
      LINK_PREVIEW_INFLIGHT.delete(url);
      return data;
    })
    .catch(() => {
      LINK_PREVIEW_CACHE.set(url, null);
      LINK_PREVIEW_INFLIGHT.delete(url);
      return null;
    });
  LINK_PREVIEW_INFLIGHT.set(url, task);
  return task;
}

function LinkPreviewAnchor({ href, children }: { href?: string; children: ReactNode }) {
  const normalizedHref = normalizeHref(href);
  const parsed = parseUrl(normalizedHref);
  if (!parsed || !normalizedHref) {
    return <span>{children}</span>;
  }
  const childText = getNodeText(children).trim();
  const isRawHref =
    !childText ||
    childText === href ||
    childText === normalizedHref ||
    childText === decodeURIComponent(href ?? "") ||
    childText === decodeURIComponent(normalizedHref) ||
    childText === parsed.toString();
  const fallbackTitle = isRawHref ? getReadableLinkTitle(parsed) : childText;
  const [preview, setPreview] = useState<LinkPreviewData | null>(() => LINK_PREVIEW_CACHE.get(normalizedHref) ?? null);
  const [copiedLink, setCopiedLink] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadLinkPreview(normalizedHref).then((data) => {
      if (!cancelled) setPreview(data);
    });
    return () => {
      cancelled = true;
    };
  }, [normalizedHref]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const effectiveUrl = parseUrl(preview?.finalUrl) ?? parseUrl(preview?.url) ?? parsed;
  const fileLike = isFileLikeLink(effectiveUrl);
  const previewIsFile = Boolean(preview?.isFile);
  const fileName = preview?.fileName?.trim() || getDisplayFileName(effectiveUrl);
  const title = preview?.title?.trim() || fallbackTitle;
  const fileTitle = preview?.title?.trim() || fileName || fallbackTitle;
  const description = preview?.description?.trim() || "";
  const siteName = effectiveUrl.hostname.replace(/^www\./, "");
  const iconUrl = getFaviconUrl(effectiveUrl);
  const [iconFailed, setIconFailed] = useState(false);

  useEffect(() => {
    setIconFailed(false);
  }, [iconUrl]);

  const handleCopyLink = useCallback(async (ev: React.MouseEvent<HTMLButtonElement>) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!window.navigator?.clipboard?.writeText) return;
    await window.navigator.clipboard.writeText(normalizedHref);
    setCopiedLink(true);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedLink(false);
      copyTimerRef.current = null;
    }, 1200);
  }, [normalizedHref]);

  const imageUrl = preview?.finalUrl || normalizedHref;
  const isImage = isImageLink(effectiveUrl, preview?.contentType);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);

  if (isImage && !imgError) {
    return (
      <a
        href={normalizedHref}
        target="_blank"
        rel="noopener noreferrer"
        className="image-preview-card"
      >
        <img
          src={imageUrl}
          alt={fileName || "图片"}
          className={`image-preview-img ${imgLoaded ? "loaded" : ""}`}
          loading="lazy"
          onLoad={() => setImgLoaded(true)}
          onError={() => setImgError(true)}
        />
        {!imgLoaded && <span className="image-preview-loading">加载中...</span>}
      </a>
    );
  }

  if (fileLike || previewIsFile) {
    return (
      <a
        href={normalizedHref}
        target="_blank"
        rel="noopener noreferrer"
        className="link-preview-card file-link-card"
      >
        <button
          type="button"
          className="link-preview-copy-btn"
          onClick={(ev) => {
            void handleCopyLink(ev);
          }}
          aria-label={copiedLink ? "已复制链接" : "复制链接"}
          title={copiedLink ? "已复制链接" : "复制链接"}
        >
          {copiedLink ? "已复制" : "复制链接"}
        </button>
        <span className="link-preview-badge">下载文件</span>
        <span className="link-preview-title">{fileTitle}</span>
        <span className="link-preview-meta">{fileName} · {siteName}</span>
      </a>
    );
  }

  return (
    <a href={normalizedHref} target="_blank" rel="noopener noreferrer" className="link-preview-card">
      <button
        type="button"
        className="link-preview-copy-btn"
        onClick={(ev) => {
          void handleCopyLink(ev);
        }}
        aria-label={copiedLink ? "已复制链接" : "复制链接"}
        title={copiedLink ? "已复制链接" : "复制链接"}
      >
        {copiedLink ? "已复制" : "复制链接"}
      </button>
      <span className="link-preview-main">
        {!iconFailed ? (
          <img
            src={iconUrl}
            alt="链接站点图标"
            className="link-preview-thumb"
            loading="lazy"
            onError={() => setIconFailed(true)}
          />
        ) : (
          <span className="link-preview-icon-fallback" aria-hidden="true">🔗</span>
        )}
        <span className="link-preview-texts">
          <span className="link-preview-title">{title}</span>
          <span className="link-preview-meta">
            {siteName}
            {getReadablePath(effectiveUrl) ? ` · ${getReadablePath(effectiveUrl)}` : ""}
          </span>
        </span>
      </span>
      {description ? <span className="link-preview-desc">{description}</span> : null}
    </a>
  );
}

export const MessageList = memo(function MessageList({ messages, streamingContent, sessionKey, previews }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const [showBackToLatest, setShowBackToLatest] = useState(false);

  const isNearBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;
    const threshold = 56;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    return distance <= threshold;
  }, []);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    bottomRef.current?.scrollIntoView({ behavior });
    stickToBottomRef.current = true;
    setShowBackToLatest(false);
  }, []);

  const viewportResizingRef = useRef(false);

  const handleScroll = useCallback(() => {
    if (viewportResizingRef.current) return;
    const shouldStick = isNearBottom();
    stickToBottomRef.current = shouldStick;
    setShowBackToLatest(!shouldStick);
  }, [isNearBottom]);

  const renderItems = useMemo(
    () => groupMessages(messages, streamingContent),
    [messages, streamingContent],
  );

  const prevSessionRef = useRef(sessionKey);
  useEffect(() => {
    if (prevSessionRef.current !== sessionKey) {
      prevSessionRef.current = sessionKey;
      stickToBottomRef.current = true;
      setShowBackToLatest(false);
      requestAnimationFrame(() => scrollToLatest("auto"));
    }
  }, [sessionKey, scrollToLatest]);

  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      scrollToLatest("auto");
      return;
    }
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === "user") {
      scrollToLatest("smooth");
      return;
    }
    if (stickToBottomRef.current) {
      scrollToLatest("smooth");
      return;
    }
    setShowBackToLatest(true);
  }, [messages, streamingContent, previews, scrollToLatest]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      viewportResizingRef.current = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        viewportResizingRef.current = false;
      }, 150);
      if (stickToBottomRef.current) {
        requestAnimationFrame(() => scrollToLatest("auto"));
      }
    };
    vv.addEventListener("resize", onResize);
    return () => {
      vv.removeEventListener("resize", onResize);
      clearTimeout(timer);
    };
  }, [scrollToLatest]);

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={containerRef} onScroll={handleScroll} className="h-full overflow-y-auto py-3 space-y-1">
        {renderItems.map((item) =>
          item.kind === "tool-group" ? (
            <ActivityBlock key={item.messages[0].id} messages={item.messages} done={item.done} />
          ) : (
            <MessageBubble key={item.message.id} message={item.message} />
          ),
        )}
        {previews?.map((pv) => (
          <MessageBubble
            key={`preview-${pv.previewId}`}
            message={{ id: `preview-${pv.previewId}`, role: "assistant", content: pv.content, timestamp: Date.now() }}
          />
        ))}
        {streamingContent && (
          <MessageBubble
            message={{ id: "streaming", role: "assistant", content: streamingContent, timestamp: Date.now() }}
          />
        )}
        <div ref={bottomRef} />
      </div>
      {showBackToLatest ? (
        <button
          type="button"
          aria-label="回到最新"
          onClick={() => scrollToLatest("smooth")}
          className="absolute bottom-3 right-3 rounded-full border border-border bg-surface-secondary px-3 py-1.5 text-xs font-medium text-gray-800 shadow-md hover:bg-surface"
        >
          回到最新
        </button>
      ) : null}
    </div>
  );
});

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const hasFiles = Array.isArray(message.files) && message.files.length > 0;
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  const handleCopyCode = useCallback(async (content: string) => {
    if (!window.navigator?.clipboard?.writeText) {
      return;
    }
    await window.navigator.clipboard.writeText(content);
    setCopiedCode(content);
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => {
      setCopiedCode(null);
      copiedTimerRef.current = null;
    }, 1500);
  }, []);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  if (message.card) {
    return (
      <div className="flex justify-start px-3 py-1">
        <CardMessage card={message.card} />
      </div>
    );
  }

  if (message.audio) {
    return (
      <div className="flex justify-start px-3 py-1">
        <AudioMessage audio={message.audio} timestamp={message.timestamp} />
      </div>
    );
  }

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
            {formatMessageTime(message.timestamp)}
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
                const code = String(children).replace(/\n$/, "").trimEnd();
                if (match) {
                  const isCopied = copiedCode === code;
                  return (
                    <div className="relative group/code">
                      <button
                        type="button"
                        onClick={() => {
                          void handleCopyCode(code);
                        }}
                        className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded bg-black/35 text-xs text-white/90 transition hover:bg-black/50 hover:text-white"
                        aria-label={isCopied ? "已复制" : "复制代码"}
                        title={isCopied ? "已复制" : "复制代码"}
                      >
                        {isCopied ? "✓" : "⧉"}
                      </button>
                      <SyntaxHighlighter
                        style={oneDark}
                        language={match[1]}
                        PreTag="div"
                        wrapLongLines
                        customStyle={{
                          borderRadius: "8px",
                          margin: 0,
                          fontSize: "12.5px",
                          paddingTop: "28px",
                        }}
                      >
                        {code}
                      </SyntaxHighlighter>
                    </div>
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
              a({ href, children }) {
                if (isUser) {
                  return (
                    <a href={href} target="_blank" rel="noopener noreferrer" className="underline decoration-white/70">
                      {children}
                    </a>
                  );
                }
                const rawText = getNodeText(children).trim();
                const trailingNote = splitUrlTrailingNote(rawText);
                if (trailingNote) {
                  return (
                    <>
                      <LinkPreviewAnchor href={trailingNote.url}>
                        {trailingNote.url}
                      </LinkPreviewAnchor>
                      <span>{trailingNote.note}</span>
                    </>
                  );
                }
                return <LinkPreviewAnchor href={href}>{children}</LinkPreviewAnchor>;
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
