import fs from "node:fs";
import path from "node:path";

/**
 * 降级给模型之后，从这一轮实际干了什么里学一条快通道规则，下次同样说法就能秒回。
 *
 * 只学**确定的**：模型这轮恰好只调了一次 `bin/hass call <domain>.turn_on/off`，
 * 且能从用户原话里剥出一个名词。多次调用、查询类、复杂操作都不学 ——
 * 学错一条会让以后每次都开错灯，宁可不学。
 */

const LEARNED_FILE = "learned-aliases.json";

/** 和 fast-path.ts 的动作词表保持一致 */
const ACTION_WORDS = [
  "关闭", "关掉", "关上", "闭合", "停止", "关",
  "打开", "开启", "启动", "执行", "切换到", "开",
];
const FILLER = /^(帮我|帮忙|请|麻烦|你|把|将|给我|现在|立刻|马上|顺便)+/;

/** 只有这些服务是「幂等的开关动作」，适合固化成规则 */
const LEARNABLE_SERVICES = new Set([
  "turn_on", "turn_off", "open_cover", "close_cover",
  "open_valve", "close_valve", "lock", "unlock",
]);

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface LearnResult {
  learned: boolean;
  reason: string;
  name?: string;
  entityId?: string;
}

/** 从 `bin/hass call switch.turn_on '{"entity_id":"switch.x"}'` 里抠出 domain.service 和 entity_id */
export function parseHassCall(command: string): { service: string; entityId: string } | null {
  const m = /bin\/hass\s+call\s+([a-z_]+\.[a-z_]+)\s+(.+)/s.exec(command);
  if (!m) return null;
  const service = m[1];
  // 参数是被单引号或双引号包起来的 JSON
  const rawArg = m[2].trim().replace(/^['"]|['"]$/g, "");
  let entityId: string | undefined;
  try {
    const parsed = JSON.parse(rawArg);
    const e = parsed?.entity_id;
    entityId = Array.isArray(e) ? (e.length === 1 ? e[0] : undefined) : e;
  } catch {
    return null;
  }
  if (typeof entityId !== "string" || !entityId.includes(".")) return null;
  return { service, entityId };
}

/** 把用户原话剥成一个可当作设备名的名词 */
export function extractName(content: string): string | null {
  let s = content.trim().replace(/[。！!？?，,、\s]+/g, "").replace(FILLER, "");
  for (const w of ACTION_WORDS) {
    if (s.includes(w)) {
      s = s.split(w).join("");
      break;
    }
  }
  s = s.replace(/^(一下|下|吧|了)+|(一下|下|吧|了)+$/g, "");
  // 太短的（「灯」）指向不明，太长的不像设备名
  if (s.length < 2 || s.length > 12) return null;
  // 含数字/英文的多半是内部标识，不收
  if (/[a-zA-Z0-9]/.test(s)) return null;
  return s;
}

function readJson(file: string): { entities: Record<string, string>; [k: string]: unknown } {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed.entities === "object") return parsed;
  } catch {
    /* 文件不存在或坏了，下面重建 */
  }
  return {
    _comment: "降级给模型后自动学到的规则，由 cc-pet-web 写入。可以手工删错的条目。",
    entities: {},
  };
}

/**
 * 分析一轮降级执行，够确定就把规则写进 learned-aliases.json。
 *
 * @param known 已经能命中的名字（自动表 + 手工表），避免重复学
 */
export function learnFromRun(
  content: string,
  toolCalls: ToolCall[],
  dir: string,
  known: Set<string>,
): LearnResult {
  const commands = toolCalls
    .filter((c) => c.name === "Bash" && typeof c.input?.command === "string")
    .map((c) => String(c.input.command));

  const calls = commands.map(parseHassCall).filter((x): x is NonNullable<typeof x> => x !== null);
  if (calls.length === 0) return { learned: false, reason: "这轮没有调 bin/hass call" };
  // 多次调用说不清哪条对应用户那句话
  if (calls.length > 1) return { learned: false, reason: `调了 ${calls.length} 次，无法归因` };

  const { service, entityId } = calls[0];
  const bare = service.split(".")[1] ?? "";
  if (!LEARNABLE_SERVICES.has(bare)) {
    return { learned: false, reason: `服务 ${service} 不是幂等开关动作` };
  }

  const name = extractName(content);
  if (!name) return { learned: false, reason: "从原话里剥不出设备名" };
  if (known.has(name)) return { learned: false, reason: `「${name}」已经能命中` };

  const file = path.join(dir, LEARNED_FILE);
  const data = readJson(file);
  if (data.entities[name] === entityId) {
    return { learned: false, reason: `「${name}」已学过` };
  }

  data.entities[name] = entityId;
  data.entities = Object.fromEntries(Object.entries(data.entities).sort());
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return { learned: true, reason: "已学会", name, entityId };
}
