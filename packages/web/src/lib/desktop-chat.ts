import { getPlatform, isTauri } from "./platform.js";
import { useUIStore } from "./store/ui.js";

/** 桌面端：收起聊天窗口并切回宠物模式（与 Pet 条操作一致）。 */
export function closeDesktopChat(): void {
  if (!isTauri()) return;
  useUIStore.getState().setWindowMode("pet");
  void getPlatform().setWindowMode?.("pet");
}
