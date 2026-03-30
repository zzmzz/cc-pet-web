import {
  forwardRef,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";

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
      disabled,
      placeholder = "输入消息，Enter 发送，Shift+Enter 换行",
    },
    ref,
  ) {
    const fileRef = useRef<HTMLInputElement>(null);
    const composingRef = useRef(false);
    const safeValue = value ?? "";
    const sendBtnDisabled = sendDisabled ?? (!safeValue.trim() || !!disabled);

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
      <div className="border-t border-gray-100 p-3 shrink-0 bg-white">
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
