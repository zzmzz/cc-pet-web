import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tryFastPath, loadMappings, resetMappingCache } from "./fast-path.js";

let dir: string;
const fetchMock = vi.fn();

function write(file: string, entities: Record<string, string>) {
  fs.writeFileSync(path.join(dir, file), JSON.stringify({ entities }));
}

function opts() {
  return { dir, haUrl: "http://ha.test:8123", haToken: "tok" };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastpath-"));
  resetMappingCache();
  fetchMock.mockReset().mockResolvedValue({ ok: true, status: 200, text: async () => "[]" });
  vi.stubGlobal("fetch", fetchMock);
  write("fast-path.json", {
    "客厅灯": "switch.living_right",
    "洗墙灯": "switch.living_left",
    "主卧灯": "switch.bedroom",
    "客厅纱帘": "cover.living_curtain",
    "回家": "scene.come_home",
    "加湿器": "humidifier.hum",
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: String(url), body: JSON.parse(String((init as any).body)) };
}

describe("tryFastPath", () => {
  it("turns a switch on", async () => {
    const hit = await tryFastPath("开客厅灯", opts());
    expect(hit).toMatchObject({ ttsText: "开了", entityId: "switch.living_right", service: "switch.turn_on" });
    expect(lastCall().url).toBe("http://ha.test:8123/api/services/switch/turn_on");
    expect(lastCall().body).toEqual({ entity_id: "switch.living_right" });
  });

  it("turns a switch off", async () => {
    const hit = await tryFastPath("关闭主卧灯", opts());
    expect(hit).toMatchObject({ ttsText: "关了", service: "switch.turn_off" });
  });

  it("strips filler words", async () => {
    for (const phrase of ["帮我把客厅灯打开", "请打开客厅灯", "把客厅灯开一下"]) {
      fetchMock.mockClear();
      const hit = await tryFastPath(phrase, opts());
      expect(hit, phrase).not.toBeNull();
      expect(hit!.entityId, phrase).toBe("switch.living_right");
    }
  });

  // 这是最要紧的一条：同一个面板上「客厅灯」和「洗墙灯」是两个按键，
  // 早期模型就在这里答错过。快通道必须按名字精确落到对应实体。
  it("distinguishes two buttons on the same panel", async () => {
    expect((await tryFastPath("开洗墙灯", opts()))!.entityId).toBe("switch.living_left");
    expect((await tryFastPath("开客厅灯", opts()))!.entityId).toBe("switch.living_right");
  });

  it("prefers the longest matching name", async () => {
    // 「客厅纱帘」里也含「客厅灯」吗？不含；但含更短的候选时必须取最长的
    write("fast-path.json", { "灯": "switch.generic", "客厅灯": "switch.living_right" });
    resetMappingCache();
    expect((await tryFastPath("开客厅灯", opts()))!.entityId).toBe("switch.living_right");
  });

  it("maps cover to open_cover / close_cover", async () => {
    expect((await tryFastPath("打开客厅纱帘", opts()))!.service).toBe("cover.open_cover");
    expect((await tryFastPath("关闭客厅纱帘", opts()))!.service).toBe("cover.close_cover");
  });

  it("triggers a scene", async () => {
    const hit = await tryFastPath("执行回家", opts());
    expect(hit).toMatchObject({ ttsText: "好了", service: "scene.turn_on" });
  });

  it("refuses to 'turn off' a scene — that has no meaning, let the model explain", async () => {
    expect(await tryFastPath("关闭回家", opts())).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("declines (falls back to the model)", () => {
    it("questions, not commands", async () => {
      for (const q of ["客厅灯开着吗", "客厅灯什么状态", "家里怎么样", "现在多少度"]) {
        expect(await tryFastPath(q, opts()), q).toBeNull();
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("no action word", async () => {
      expect(await tryFastPath("客厅灯", opts())).toBeNull();
    });

    it("unknown device", async () => {
      expect(await tryFastPath("开阳台的那个灯", opts())).toBeNull();
    });

    it("ambiguous same-length names", async () => {
      write("fast-path.json", { "前灯": "switch.a", "后灯": "switch.b" });
      resetMappingCache();
      // 两个名字都命中且长度相同 → 宁可降级也不猜
      expect(await tryFastPath("打开前灯后灯", opts())).toBeNull();
    });

    it("a domain with no service mapping", async () => {
      write("fast-path.json", { "温度计": "sensor.temp" });
      resetMappingCache();
      expect(await tryFastPath("打开温度计", opts())).toBeNull();
    });
  });

  it("surfaces HA errors instead of pretending it worked", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, text: async () => "bad gateway" });
    await expect(tryFastPath("开客厅灯", opts())).rejects.toThrow(/502/);
  });
});

describe("loadMappings", () => {
  it("layers learned < auto < manual", async () => {
    write("learned-aliases.json", { "大灯": "switch.learned", "客厅灯": "switch.learned_wrong" });
    write("aliases.json", { "客厅灯": "switch.manual_wins" });
    resetMappingCache();
    const m = loadMappings(dir);
    expect(m.get("大灯")).toBe("switch.learned");       // learned 补充新名字
    expect(m.get("客厅灯")).toBe("switch.manual_wins");  // 手工的最权威
    expect(m.get("洗墙灯")).toBe("switch.living_left");  // 自动表照旧生效
  });

  it("survives a corrupt file instead of taking the endpoint down", () => {
    fs.writeFileSync(path.join(dir, "aliases.json"), "{ not json");
    resetMappingCache();
    expect(loadMappings(dir).get("客厅灯")).toBe("switch.living_right");
  });

  it("picks up a regenerated file (cron rewrites it daily)", () => {
    resetMappingCache();
    expect(loadMappings(dir).get("客厅灯")).toBe("switch.living_right");
    // mtime 精度可能到毫秒，显式改时间确保被判定为变化
    write("fast-path.json", { "客厅灯": "switch.moved" });
    const f = path.join(dir, "fast-path.json");
    const t = new Date(Date.now() + 5_000);
    fs.utimesSync(f, t, t);
    expect(loadMappings(dir).get("客厅灯")).toBe("switch.moved");
  });
});
