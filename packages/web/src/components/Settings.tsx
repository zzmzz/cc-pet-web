import { useState, useEffect } from "react";
import type { AppConfig, BridgeConfig } from "@cc-pet/shared";
import { useConfigStore } from "../lib/store/config.js";
import { useUIStore } from "../lib/store/ui.js";
import { getPlatform } from "../lib/platform.js";
import { randomId } from "../lib/utils.js";

export function Settings() {
  const config = useConfigStore((s) => s.config);
  const setConfig = useConfigStore((s) => s.setConfig);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const [bridges, setBridges] = useState<BridgeConfig[]>(config?.bridges ?? []);

  useEffect(() => {
    if (config) setBridges(config.bridges);
  }, [config]);

  const addBridge = () => {
    setBridges([...bridges, { id: randomId(), name: "", host: "localhost", port: 9810, token: "", enabled: true }]);
  };

  const removeBridge = (id: string) => {
    setBridges(bridges.filter((b) => b.id !== id));
  };

  const updateBridge = (id: string, field: keyof BridgeConfig, value: any) => {
    setBridges(bridges.map((b) => (b.id === id ? { ...b, [field]: value } : b)));
  };

  const save = async () => {
    const newConfig: AppConfig = {
      ...config!,
      bridges,
    };
    try {
      await getPlatform().fetchApi("/api/config", { method: "PUT", body: JSON.stringify(newConfig) });
      setConfig(newConfig);
      setSettingsOpen(false);
    } catch (e) {
      console.error("Failed to save config", e);
    }
  };

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">设置</h2>
        <button className="text-gray-400 hover:text-gray-200" onClick={() => setSettingsOpen(false)}>✕</button>
      </div>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-gray-300">Bridge 连接</h3>
          <button className="text-xs text-accent hover:underline" onClick={addBridge}>+ 添加</button>
        </div>
        {bridges.map((b) => (
          <div key={b.id} className="bg-surface-tertiary rounded-lg p-3 mb-2 space-y-2">
            <div className="flex gap-2">
              <input className="flex-1 bg-surface rounded px-2 py-1 text-sm text-gray-200 outline-none" placeholder="名称"
                value={b.name} onChange={(e) => updateBridge(b.id, "name", e.target.value)} />
              <button className="text-red-400 text-xs" onClick={() => removeBridge(b.id)}>删除</button>
            </div>
            <div className="flex gap-2">
              <input className="flex-1 bg-surface rounded px-2 py-1 text-sm text-gray-200 outline-none" placeholder="Host"
                value={b.host} onChange={(e) => updateBridge(b.id, "host", e.target.value)} />
              <input className="w-20 bg-surface rounded px-2 py-1 text-sm text-gray-200 outline-none" placeholder="Port" type="number"
                value={b.port} onChange={(e) => updateBridge(b.id, "port", parseInt(e.target.value) || 0)} />
            </div>
            <input className="w-full bg-surface rounded px-2 py-1 text-sm text-gray-200 outline-none" placeholder="Token"
              type="password" value={b.token} onChange={(e) => updateBridge(b.id, "token", e.target.value)} />
          </div>
        ))}
      </section>

      <button className="w-full bg-accent rounded-lg py-2 text-white text-sm font-medium" onClick={save}>
        保存
      </button>
    </div>
  );
}
