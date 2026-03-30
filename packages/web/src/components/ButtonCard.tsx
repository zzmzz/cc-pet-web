import type { ButtonOption } from "@cc-pet/shared";
import { useState } from "react";

interface Props {
  content?: string;
  buttons: ButtonOption[];
  onSelect: (buttonId: string, customInput?: string) => void;
}

export function ButtonCard({ content, buttons, onSelect }: Props) {
  const [customInput, setCustomInput] = useState("");
  const [selected, setSelected] = useState(false);

  if (selected) return null;

  return (
    <div className="bg-surface-tertiary rounded-lg p-3 space-y-2">
      {content && <p className="text-sm text-gray-300">{content}</p>}
      <div className="flex flex-wrap gap-2">
        {buttons.map((btn) => (
          <button
            key={btn.id}
            className="bg-accent/20 hover:bg-accent/30 text-accent px-3 py-1.5 rounded text-sm transition"
            onClick={() => { setSelected(true); onSelect(btn.id); }}
          >
            {btn.label}
          </button>
        ))}
      </div>
      <div className="flex gap-2 mt-2">
        <input
          className="flex-1 bg-surface rounded px-2 py-1 text-sm text-gray-200 outline-none placeholder:text-gray-600"
          placeholder="自定义输入..."
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && customInput.trim()) {
              setSelected(true);
              onSelect("custom", customInput.trim());
            }
          }}
        />
      </div>
    </div>
  );
}
