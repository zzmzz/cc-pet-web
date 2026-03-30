import { useMemo } from "react";
import type { SlashCommand, SlashCommandCategory } from "@cc-pet/shared";

export interface SlashCommandSpec {
  command: string;
  description: string;
  category: SlashCommandCategory;
  type: "local" | "send";
}

export const BUILTIN_COMMANDS: SlashCommandSpec[] = [
  { command: "/clear", description: "清空聊天记录", category: "builtin", type: "local" },
  { command: "/settings", description: "打开设置面板", category: "builtin", type: "local" },
  { command: "/connect", description: "连接 cc-connect Bridge", category: "builtin", type: "local" },
  { command: "/disconnect", description: "断开 cc-connect Bridge", category: "builtin", type: "local" },
];

export const CC_CONNECT_COMMANDS: SlashCommandSpec[] = [
  { command: "/new", description: "开始新会话 /new [name]", category: "session", type: "send" },
  { command: "/list", description: "列出所有会话", category: "session", type: "send" },
  { command: "/switch", description: "切换会话 /switch <id>", category: "session", type: "send" },
  { command: "/current", description: "当前会话信息", category: "session", type: "send" },
  { command: "/history", description: "查看最近消息 /history [n]", category: "session", type: "send" },
  { command: "/stop", description: "停止当前执行", category: "session", type: "send" },
  {
    command: "/model",
    description: "查看/切换模型 /model [switch <alias>]",
    category: "agent",
    type: "send",
  },
  {
    command: "/mode",
    description: "查看/切换权限模式 /mode [yolo|default|plan]",
    category: "agent",
    type: "send",
  },
  {
    command: "/reasoning",
    description: "调整推理级别 /reasoning [level]",
    category: "agent",
    type: "send",
  },
  {
    command: "/provider",
    description: "管理 API 提供商 /provider [list|switch]",
    category: "agent",
    type: "send",
  },
  { command: "/allow", description: "预授权工具 /allow <tool>", category: "agent", type: "send" },
  { command: "/quiet", description: "切换思考/工具进度消息", category: "agent", type: "send" },
  { command: "/dir", description: "查看/切换工作目录 /dir [path]", category: "dir", type: "send" },
  { command: "/cd", description: "/dir 的兼容别名 /cd <path>", category: "dir", type: "send" },
  {
    command: "/cron",
    description: "管理定时任务 /cron [add|del|enable|disable]",
    category: "cron",
    type: "send",
  },
  {
    command: "/cron setup",
    description: "刷新 agent 指令（含附件回传）",
    category: "cron",
    type: "send",
  },
  { command: "/help", description: "显示所有可用命令", category: "other", type: "send" },
  { command: "/usage", description: "显示账户/模型配额使用情况", category: "other", type: "send" },
  {
    command: "/bind",
    description: "管理多机器人绑定 /bind [project|setup]",
    category: "other",
    type: "send",
  },
  {
    command: "/workspace",
    description: "多工作区管理 /workspace [bind|list]",
    category: "other",
    type: "send",
  },
];

export const CATEGORY_LABELS: Record<string, string> = {
  builtin: "CC Pet",
  session: "会话管理",
  agent: "Agent 控制",
  dir: "工作目录",
  cron: "定时任务",
  skill: "Skills",
  other: "其他",
};

/** Normalize bridge payloads that may use `command` instead of `name`. */
export function normalizeBridgeSlashCommands(raw: unknown[] | undefined): SlashCommand[] {
  if (!raw?.length) return [];
  const out: SlashCommand[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const token = o.name ?? o.command ?? "";
    const name = String(token).replace(/^\//, "").trim();
    if (!name) continue;
    out.push({
      name,
      description: String(o.description ?? ""),
      category: o.category as SlashCommandCategory | undefined,
      type: o.type as SlashCommand["type"] | undefined,
    });
  }
  return out;
}

export function bridgeSlashToSpec(c: SlashCommand): SlashCommandSpec {
  const cmd = c.name.startsWith("/") ? c.name : `/${c.name}`;
  return {
    command: cmd,
    description: c.description,
    category: c.category ?? "skill",
    type: c.type === "local" ? "local" : "send",
  };
}

export function useSlashMenu(input: string) {
  const isActive = useMemo(() => {
    const trimmed = input.trimStart();
    return trimmed.startsWith("/");
  }, [input]);

  const query = useMemo(() => {
    if (!isActive) return "";
    return input.trimStart().slice(1).toLowerCase();
  }, [isActive, input]);

  return { isActive, query };
}

export function getFilteredCommands(
  query: string,
  extraBridgeCommands: SlashCommand[] = [],
): SlashCommandSpec[] {
  const extra = extraBridgeCommands.map(bridgeSlashToSpec);
  const all = [...BUILTIN_COMMANDS, ...CC_CONNECT_COMMANDS, ...extra];
  if (!query) return all;
  return all.filter(
    (cmd) =>
      cmd.command.toLowerCase().includes(query) || cmd.description.toLowerCase().includes(query),
  );
}
