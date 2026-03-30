import type { SlashCommand } from "@cc-pet/shared";

interface Props {
  commands: SlashCommand[];
  filter: string;
  onSelect: (command: SlashCommand) => void;
  visible: boolean;
}

export function SlashCommandMenu({ commands, filter, onSelect, visible }: Props) {
  if (!visible || commands.length === 0) return null;

  const filtered = commands.filter((c) =>
    c.name.toLowerCase().includes(filter.toLowerCase())
  );

  if (filtered.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 bg-surface-secondary border border-border rounded-lg shadow-lg max-h-48 overflow-y-auto">
      {filtered.map((cmd) => (
        <button
          key={cmd.name}
          className="block w-full text-left px-3 py-2 text-sm hover:bg-surface-tertiary"
          onClick={() => onSelect(cmd)}
        >
          <span className="text-accent">/{cmd.name}</span>
          <span className="text-gray-500 ml-2">{cmd.description}</span>
        </button>
      ))}
    </div>
  );
}
