import fs from "node:fs";
import path from "node:path";

/**
 * 语音控制的快通道：「开客厅灯」这种指令直接查表调 HA，不过模型。
 *
 * 为什么值得单开一条路：实测走 claude 要 11 秒，其中真正调 HA 只占 0.4 秒 ——
 * 6.1 秒是模型读 74K context 想「该调什么」，1.6 秒是模型组织「关了」两个字，
 * 剩下是进程启停。而中文名 → entity_id 本来就是一次查表，不需要推理。
 *
 * 原则：**只在每个动作都能精确定位时才走，宁可降级也不猜。** 匹配不上、有歧义、
 * 是查询而非命令的，一律回退给模型 —— 那条路的行为完全不变。
 */

/** 动作词 → 意图。长的排前面，避免「关闭」被「关」抢先匹配掉。 */
const TURN_OFF_WORDS = ["关闭", "关掉", "关上", "闭合", "停止", "关"];
const TURN_ON_WORDS = ["打开", "开启", "启动", "执行", "切换到", "开"];

/** 说话里的口水词，匹配前先剥掉 */
const FILLER = /^(帮我|帮忙|请|麻烦|你|把|将|给我|现在|立刻|马上|顺便|然后|再|接着)+/;

/** 复合指令的分隔符：「关闭客厅空调，打开主卧空调」要拆成两步分别执行 */
const CLAUSE_SPLIT = /[，,。;；、]+|然后|接着|顺便|再帮我|同时/;

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
  /** 这一句实际做了几件事 */
  steps: { name: string; entityId: string; service: string; ok: boolean }[];
}

interface Step {
  name: string;
  entityId: string;
  domain: string;
  service: string;
  intent: "on" | "off";
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

/** 是查询而不是命令？那交给模型 */
function isQuestion(content: string): boolean {
  return /[吗呢?？]$/.test(content.trim()) || /什么状态|怎么样|多少度|开着还是/.test(content);
}

/**
 * 在文本里找设备名。取**最长**的匹配 —— 「洗墙灯」和「灯」都可能命中，
 * 显然该用前者。长度并列时视为歧义，放弃。
 */
function matchName(text: string, mappings: Map<string, string>): string | null {
  let best: string | null = null;
  let tie = false;
  for (const name of mappings.keys()) {
    if (!text.includes(name)) continue;
    if (!best || name.length > best.length) {
      best = name;
      tie = false;
    } else if (name.length === best.length && name !== best) {
      tie = true;
    }
  }
  return tie ? null : best;
}

/** 把一个子句解析成一步操作。任何一点不确定就返回 null。 */
function planStep(clause: string, mappings: Map<string, string>): Step | null {
  let s = clause.trim().replace(/[。！!？?\s]+/g, "").replace(FILLER, "");
  if (!s) return null;

  const hasOff = TURN_OFF_WORDS.some((w) => s.includes(w));
  const hasOn = TURN_ON_WORDS.some((w) => s.includes(w));
  // 一个子句里同时出现开和关，说明没切干净（或者本来就说得含糊）—— 交给模型
  if (hasOff && hasOn) return null;
  if (!hasOff && !hasOn) return null;

  const intent: "on" | "off" = hasOff ? "off" : "on";
  for (const w of intent === "off" ? TURN_OFF_WORDS : TURN_ON_WORDS) {
    s = s.split(w).join("");
  }

  const name = matchName(s, mappings);
  if (!name) return null;

  const entityId = mappings.get(name)!;
  const domain = entityId.split(".", 1)[0];
  const service = SERVICES[domain]?.[intent];
  // 没有服务映射，或者对场景说「关闭」（没这个概念）—— 让模型去解释
  if (!service) return null;

  return { name, entityId, domain, service, intent };
}

/**
 * 把一句话拆成若干步。**任何一步解析不出来就整句返回 null**，
 * 绝不半执行 —— 否则「关闭客厅空调，打开主卧空调」会变成只关了客厅、
 * 却回一句「关了」，让人以为两件都做了。
 */
export function planSteps(content: string, mappings: Map<string, string>): Step[] | null {
  if (isQuestion(content)) return null;

  const clauses = content
    .split(CLAUSE_SPLIT)
    .map((c) => c.trim())
    .filter(Boolean);
  if (clauses.length === 0) return null;

  const steps: Step[] = [];
  for (const clause of clauses) {
    const step = planStep(clause, mappings);
    if (!step) return null;
    steps.push(step);
  }

  // 同一个实体在一句话里被指挥两次（「开客厅灯，关客厅灯」），意图矛盾，交给模型
  const seen = new Set<string>();
  for (const s of steps) {
    if (seen.has(s.entityId)) return null;
    seen.add(s.entityId);
  }
  return steps;
}

async function callHa(step: Step, options: FastPathOptions): Promise<void> {
  const res = await fetch(
    `${options.haUrl.replace(/\/$/, "")}/api/services/${step.domain}/${step.service}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.haToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ entity_id: step.entityId }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    },
  );
  if (!res.ok) throw new Error(`HA ${res.status}: ${(await res.text()).slice(0, 120)}`);
}

function verbOf(step: Step): string {
  if (step.domain === "scene" || step.domain === "script") return "好了";
  return step.intent === "on" ? "开了" : "关了";
}

export async function tryFastPath(
  content: string,
  options: FastPathOptions,
): Promise<FastPathResult | null> {
  const mappings = loadMappings(options.dir);
  const steps = planSteps(content, mappings);
  if (!steps) return null;

  // 单步：失败就抛出去，让端点降级给模型（模型也许有别的办法）
  if (steps.length === 1) {
    await callHa(steps[0], options);
    return {
      ttsText: verbOf(steps[0]),
      steps: [{ ...steps[0], ok: true }],
    };
  }

  // 多步：逐个执行且**不抛错**。一旦有步骤已经生效，降级重跑会把它做第二遍，
  // 所以这里自己把成败讲清楚，而不是把整句丢回给模型。
  const done: FastPathResult["steps"] = [];
  for (const step of steps) {
    try {
      await callHa(step, options);
      done.push({ ...step, ok: true });
    } catch {
      done.push({ ...step, ok: false });
    }
  }

  const failed = done.filter((d) => !d.ok);
  if (failed.length === 0) return { ttsText: "都好了", steps: done };
  if (failed.length === done.length) return { ttsText: "都没弄成", steps: done };
  return {
    ttsText: `${done.length - failed.length}个弄好了，${failed.map((f) => f.name).join("和")}没成`,
    steps: done,
  };
}
