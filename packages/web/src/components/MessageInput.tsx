import { useState, useRef, type KeyboardEvent } from "react";

interface Props {
  onSend: (content: string) => void;
  onFileUpload?: (file: File) => void;
  disabled?: boolean;
}

export function MessageInput({ onSend, onFileUpload, disabled }: Props) {
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
  };

  return (
    <div className="flex items-end gap-2 p-3 bg-surface-secondary border-t border-border">
      <button className="text-gray-400 hover:text-gray-200 pb-1" onClick={() => fileRef.current?.click()}>
        📎
      </button>
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFileUpload?.(file);
          e.target.value = "";
        }}
      />
      <textarea
        className="flex-1 bg-surface-tertiary rounded-lg px-3 py-2 text-sm text-gray-200 resize-none outline-none placeholder:text-gray-600"
        rows={1}
        placeholder="输入消息..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
      />
      <button
        className="bg-accent rounded-lg px-4 py-2 text-white text-sm font-medium disabled:opacity-40"
        onClick={handleSend}
        disabled={!text.trim() || disabled}
      >
        发送
      </button>
    </div>
  );
}
