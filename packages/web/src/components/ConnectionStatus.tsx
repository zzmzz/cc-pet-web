import { useConnectionStore } from "../lib/store/connection.js";

export function ConnectionStatus() {
  const { connections, activeConnectionId } = useConnectionStore();
  const active = connections.find((c) => c.id === activeConnectionId);
  if (!active) return null;

  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${active.connected ? "bg-green-500" : "bg-red-500"}`} />
      <span className="text-sm text-gray-300 truncate">{active.name}</span>
    </div>
  );
}
