import fs from "node:fs";
import path from "node:path";

/**
 * 语音控制的快通道：「开客厅灯」这种指令直接查表调 HA，不过模型。
 *
 * 为什么值得单开一条路：实测走 claude 要 11 秒，其中真正调 HA 只占 0.4 秒 ——
 * 6.1 秒是模型读 74K context 想「该调什么」，1.6 秒是模型组织「关了」两个字，
 * 剩下是进程启停。而中文名 → entity_id 本来就是一次查表，不需要推理。
 *
 * 原则：**只在精确唯一匹配时才走，宁可降级也不猜。** 匹配不上、有歧义、
 * 是查询而非命令的，一律回退给模型 —— 那条路的行为完全不变。
 */

/** 动作词 → 意图。长的排前面，避免「关闭」被「关」抢先匹配掉。 */
const TURN_OFF_WORDS = ["关闭", "关掉", "关上", "闭合", "停止", "关"];
const TURN_ON_WORDS = ["打开", "开启", "启动", "执行", "切换到", "开"];

/** 说话里的口水词，匹配前先剥掉 */
const FILLER = /^(帮我|帮忙|请|麻烦|你|把|将|给我|现在|立刻|马上|顺便)+/;

/** 每个域该调什么服务 */
const SERVICES: Record<string, { on: string; off: string | null }> = {
  switch: { on: "turn_on", off: "turn_off" },
  light: { on: "turn_on", off: "turn_off" },
  fan: { on: "turn_on", off: "turn_off" },
  humidifier: { on: "turn_on", off: "turn_off" },
  input_boolean: { on: "turn_on", off: "turn_off" },
  cover: { on: "open_cover", off: "close_cover" },
  valve: { on: "open_valve", off: "close_valve" },
  lock: { on: "unlock", off: "lock" },
  // 场景和脚本只有「触发」，没有关
  scene: { on: "turn_on", off: null },
  script: { on: "turn_on", off: null },
};

export interface FastPathOptions {
  /** hass-agent 目录，放着 fast-path.json / aliases.json / learned-aliases.json */
  dir: string;
  haUrl: string;
  haToken: string;
  timeoutMs?: number;
}

export interface FastPathResult {
  ttsText: string;
  name: string;
  entityId: string;
  service: string;
}

interface MappingCache {
  merged: Map<string, string>;
  /** 各文件的 mtimeMs，用来判断要不要重读（cron 每天重生成一次） */
  stamps: string;
}

let cache: MappingCache | null = null;

const FILES = ["learned-aliases.json", "fast-path.json", "aliases.json"] as const;

function readEntities(file: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const e = parsed?.entities;
    return e && typeof e === "object" ? e : {};
  } catch {
    return {};
  }
}

/** 三层映射，后加载的覆盖先加载的：learned < auto < manual（手工的最权威） */
export function loadMappings(dir: string): Map<string, string> {
  const paths = FILES.map((f) => path.join(dir, f));
  const stamps = paths
    .map((p) => {
      try {
        return String(fs.statSync(p).mtimeMs);
      } catch {
        return "-";
      }
    })
    .join("|");

  if (cache && cache.stamps === stamps) return cache.merged;

  const merged = new Map<string, string>();
  for (const p of paths) {
    for (const [name, eid] of Object.entries(readEntities(p))) {
      if (typeof eid === "string" && eid.includes(".")) merged.set(name, eid);
    }
  }
  cache = { merged, stamps };
  return merged;
}

/** 供测试重置模块级缓存 */
export function resetMappingCache(): void {
  cache = null;
}

interface Parsed {
  intent: "on" | "off";
  /** 剥掉动作词和口水词后剩下的部分，用来找设备名 */
  rest: string;
}

function parse(content: string): Parsed | null {
  let s = content.trim().replace(/[。！!？?，,、\s]+/g, "");
  s = s.replace(FILLER, "");
  if (!s) return null;

  // 带疑问语气的是查询不是命令（「客厅灯开着吗」），交给模型
  if (/[吗呢?？]$/.test(content.trim()) || /什么状态|怎么样|多少度/.test(content)) {
    return null;
  }

  for (const w of TURN_OFF_WORDS) {
    if (s.includes(w)) return { intent: "off", rest: s.split(w).join("") };
  }
  for (const w of TURN_ON_WORDS) {
    if (s.includes(w)) return { intent: "on", rest: s.split(w).join("") };
  }
  return null;
}

/**
 * 在剩余文本里找设备名。取**最长**的匹配 —— 「洗墙灯」和「灯」都可能命中，
 * 显然该用前者。长度并列时视为歧义，放弃。
 */
function matchName(rest: string, mappings: Map<string, string>): string | null {
  let best: string | null = null;
  let tie = false;
  for (const name of mappings.keys()) {
    if (!rest.includes(name)) continue;
    if (!best || name.length > best.length) {
      best = name;
      tie = false;
    } else if (name.length === best.length && name !== best) {
      tie = true;
    }
  }
  return tie ? null : best;
}

export async function tryFastPath(
  content: string,
  options: FastPathOptions,
): Promise<FastPathResult | null> {
  const parsed = parse(content);
  if (!parsed) return null;

  const mappings = loadMappings(options.dir);
  const name = matchName(parsed.rest, mappings);
  if (!name) return null;

  const entityId = mappings.get(name)!;
  const domain = entityId.split(".", 1)[0];
  const spec = SERVICES[domain];
  if (!spec) return null;

  const service = parsed.intent === "on" ? spec.on : spec.off;
  // 场景/脚本没有「关」这个概念，让模型去解释
  if (!service) return null;

  const res = await fetch(
    `${options.haUrl.replace(/\/$/, "")}/api/services/${domain}/${service}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.haToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ entity_id: entityId }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    },
  );
  if (!res.ok) throw new Error(`HA ${res.status}: ${(await res.text()).slice(0, 120)}`);

  const ttsText =
    domain === "scene" || domain === "script" ? "好了" : parsed.intent === "on" ? "开了" : "关了";

  return { ttsText, name, entityId, service: `${domain}.${service}` };
}
