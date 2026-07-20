import {
  forwardRef,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/** Collect File objects from a drag or clipboard DataTransfer. */
function extractFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.items && dt.items.length > 0) {
    for (const item of Array.from(dt.items)) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) out.push(file);
    }
  }
  if (out.length === 0 && dt.files && dt.files.length > 0) {
    out.push(...Array.from(dt.files));
  }
  return out;
}

/** True if a drag payload carries files (vs. plain text/html). */
function dragHasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types ?? []).includes("Files");
}

/** Pasted screenshots arrive as anonymous `image.png`; give them a unique, descriptive name. */
function normalizePastedFile(file: File, index: number): File {
  const hasRealName = !!file.name && !/^image\.\w+$/i.test(file.name);
  if (hasRealName) return file;
  const ext = (file.type.split("/")[1] || "png").replace("+xml", "");
  const name = `pasted-${Date.now()}${index ? `-${index}` : ""}.${ext}`;
  return new File([file], name, { type: file.type, lastModified: file.lastModified });
}

export interface MessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Rendered above the textarea (e.g. slash command palette) */
  slashMenu?: ReactNode;
  onFilesSelected?: (files: File[]) => void;
  pendingAttachments?: File[];
  onRemoveAttachment?: (file: File) => void;
  /** When true, disables send button (textarea stays editable unless `disabled`) */
  sendDisabled?: boolean;
  /** When true, shows stop button near send button */
  showStopButton?: boolean;
  onStop?: () => void;
  stopDisabled?: boolean;
  /** When true, disables textarea and buttons */
  disabled?: boolean;
  placeholder?: string;
}

export const MessageInput = forwardRef<HTMLTextAreaElement, MessageInputProps>(
  function MessageInput(
    {
      value,
      onChange,
      onSend,
      onKeyDown,
      slashMenu,
      onFilesSelected,
      pendingAttachments = [],
      onRemoveAttachment,
      sendDisabled,
      showStopButton,
      onStop,
      stopDisabled,
      disabled,
      placeholder = "输入消息，Enter 发送，Shift+Enter 换行",
    },
    ref,
  ) {
    const fileRef = useRef<HTMLInputElement>(null);
    const composingRef = useRef(false);
    const dragDepth = useRef(0);
    const [isDragging, setIsDragging] = useState(false);
    const safeValue = value ?? "";
    const sendBtnDisabled = sendDisabled ?? (!safeValue.trim() || !!disabled);

    const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled) return;
      const files = extractFiles(e.clipboardData);
      if (files.length === 0) return; // no files → let the default text paste run
      e.preventDefault();
      onFilesSelected?.(files.map((f, i) => normalizePastedFile(f, i)));
    };

    const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
      if (disabled || !dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setIsDragging(true);
    };

    const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
      if (disabled || !dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    };

    const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
      if (!isDragging) return;
      e.preventDefault();
      dragDepth.current -= 1;
      if (dragDepth.current <= 0) {
        dragDepth.current = 0;
        setIsDragging(false);
      }
    };

    const handleDrop = (e: DragEvent<HTMLDivElement>) => {
      dragDepth.current = 0;
      setIsDragging(false);
      if (disabled) return;
      const files = extractFiles(e.dataTransfer);
      if (files.length === 0) return;
      e.preventDefault();
      onFilesSelected?.(files);
    };

    const isImeComposing = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const native = e.nativeEvent as globalThis.KeyboardEvent;
      return composingRef.current || native.isComposing || native.keyCode === 229 || e.key === "Process";
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (onKeyDown) {
        onKeyDown(e);
        if (e.defaultPrevented) return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        if (isImeComposing(e)) return;
        e.preventDefault();
        if (!sendBtnDisabled) onSend();
      }
    };

    return (
      <div
        className="relative border-t border-gray-100 p-3 shrink-0 bg-white"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragging && (
          <div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-indigo-400 bg-indigo-50/90 text-sm font-medium text-indigo-600">
            📎 松开鼠标以添加文件
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) onFilesSelected?.(files);
            e.target.value = "";
          }}
        />
        {pendingAttachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pendingAttachments.map((file) => (
              <span
                key={`${file.name}-${file.size}-${file.lastModified}`}
                className="inline-flex items-center gap-1 max-w-full rounded-lg border border-indigo-200 bg-indigo-50/80 pl-2.5 pr-1 py-1 text-[11px] text-indigo-800"
              >
                <span className="truncate" title={file.name}>
                  📎 {file.name}
                </span>
                <button
                  type="button"
                  aria-label={`移除附件 ${file.name}`}
                  className="shrink-0 rounded px-1 text-indigo-500 hover:bg-indigo-100 hover:text-indigo-800"
                  onClick={() => onRemoveAttachment?.(file)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="relative">
          {slashMenu}
          <textarea
            ref={ref}
            className="w-full resize-none rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-[13.5px] text-gray-800 caret-gray-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all placeholder:text-gray-400"
            rows={3}
            placeholder={placeholder}
            value={safeValue}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            disabled={disabled}
          />
        </div>
        <div className="flex items-center mt-2">
          <button
            type="button"
            className="text-sm text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50 transition-colors"
            onClick={() => fileRef.current?.click()}
            disabled={disabled}
          >
            📎 文件
          </button>
          <div className="flex-1" />
          {showStopButton ? (
            <button
              type="button"
              className="mr-2 border border-red-300 bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-semibold rounded-lg px-4 py-1.5 transition-colors"
              onClick={onStop}
              disabled={stopDisabled ?? disabled}
            >
              停止
            </button>
          ) : null}
          <button
            type="button"
            className="bg-indigo-500 hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg px-5 py-1.5 transition-colors"
            onClick={onSend}
            disabled={sendBtnDisabled}
          >
            发送
          </button>
        </div>
      </div>
    );
  },
);
