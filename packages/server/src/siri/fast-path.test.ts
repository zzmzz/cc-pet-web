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
    expect(hit!.ttsText).toBe("开了");
    expect(hit!.steps).toEqual([
      { name: "客厅灯", entityId: "switch.living_right", domain: "switch", service: "turn_on", intent: "on", ok: true },
    ]);
    expect(lastCall().url).toBe("http://ha.test:8123/api/services/switch/turn_on");
    expect(lastCall().body).toEqual({ entity_id: "switch.living_right" });
  });

  it("turns a switch off", async () => {
    const hit = await tryFastPath("关闭主卧灯", opts());
    expect(hit!.ttsText).toBe("关了");
    expect(hit!.steps[0].service).toBe("turn_off");
  });

  it("strips filler words", async () => {
    for (const phrase of ["帮我把客厅灯打开", "请打开客厅灯", "把客厅灯开一下"]) {
      fetchMock.mockClear();
      const hit = await tryFastPath(phrase, opts());
      expect(hit, phrase).not.toBeNull();
      expect(hit!.steps[0].entityId, phrase).toBe("switch.living_right");
    }
  });

  // 这是最要紧的一条：同一个面板上「客厅灯」和「洗墙灯」是两个按键，
  // 早期模型就在这里答错过。快通道必须按名字精确落到对应实体。
  it("distinguishes two buttons on the same panel", async () => {
    expect((await tryFastPath("开洗墙灯", opts()))!.steps[0].entityId).toBe("switch.living_left");
    expect((await tryFastPath("开客厅灯", opts()))!.steps[0].entityId).toBe("switch.living_right");
  });

  it("prefers the longest matching name", async () => {
    // 「客厅纱帘」里也含「客厅灯」吗？不含；但含更短的候选时必须取最长的
    write("fast-path.json", { "灯": "switch.generic", "客厅灯": "switch.living_right" });
    resetMappingCache();
    expect((await tryFastPath("开客厅灯", opts()))!.steps[0].entityId).toBe("switch.living_right");
  });

  it("maps cover to open_cover / close_cover", async () => {
    expect((await tryFastPath("打开客厅纱帘", opts()))!.steps[0].service).toBe("open_cover");
    expect((await tryFastPath("关闭客厅纱帘", opts()))!.steps[0].service).toBe("close_cover");
  });

  it("triggers a scene", async () => {
    const hit = await tryFastPath("执行回家", opts());
    expect(hit!.ttsText).toBe("好了");
    expect(hit!.steps[0]).toMatchObject({ domain: "scene", service: "turn_on" });
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

  // 这是修一个真 bug 的回归测试：改之前「关闭客厅空调，打开主卧空调」只会执行
  // 第一条、静默丢掉第二条，还回一句「关了」，让人以为两件都做了。
  describe("compound commands", () => {
    beforeEach(() => {
      write("fast-path.json", {
        "客厅空调": "switch.living_ac",
        "主卧空调": "switch.bedroom_ac",
        "客厅灯": "switch.living_light",
        "回家": "scene.come_home",
      });
      resetMappingCache();
    });

    it("runs every clause, not just the first", async () => {
      const hit = await tryFastPath("关闭客厅空调，打开主卧空调", opts());
      expect(hit!.ttsText).toBe("都好了");
      expect(hit!.steps).toEqual([
        { name: "客厅空调", entityId: "switch.living_ac", domain: "switch", service: "turn_off", intent: "off", ok: true },
        { name: "主卧空调", entityId: "switch.bedroom_ac", domain: "switch", service: "turn_on", intent: "on", ok: true },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("splits on various connectors", async () => {
      for (const phrase of [
        "关闭客厅空调，打开主卧空调",
        "关闭客厅空调；打开主卧空调",
        "关闭客厅空调然后打开主卧空调",
        "关闭客厅空调、打开主卧空调",
      ]) {
        fetchMock.mockClear();
        const hit = await tryFastPath(phrase, opts());
        expect(hit?.steps?.length, phrase).toBe(2);
      }
    });

    it("handles three clauses", async () => {
      const hit = await tryFastPath("开客厅灯，关闭客厅空调，打开主卧空调", opts());
      expect(hit!.steps.map((s) => s.service)).toEqual(["turn_on", "turn_off", "turn_on"]);
    });

    // 半执行是最坏的结果：宁可整句交给模型，也不要做一半还说「好了」
    it("declines the whole sentence if any clause is unclear", async () => {
      const hit = await tryFastPath("关闭客厅空调，打开那个不知道什么东西", opts());
      expect(hit).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("declines when a clause mixes on and off — means it did not split cleanly", async () => {
      expect(await tryFastPath("把客厅空调关了再打开", opts())).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("declines contradictory orders to the same entity", async () => {
      expect(await tryFastPath("打开客厅灯，关闭客厅灯", opts())).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // 多步时不能抛错让端点降级 —— 已经生效的那步会被模型重做一遍
    it("reports partial failure instead of throwing", async () => {
      fetchMock
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "[]" })
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "boom" });
      const hit = await tryFastPath("关闭客厅空调，打开主卧空调", opts());
      expect(hit!.ttsText).toContain("主卧空调");
      expect(hit!.ttsText).toContain("没成");
      expect(hit!.steps.map((s) => s.ok)).toEqual([true, false]);
    });

    it("says so when every step fails", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
      const hit = await tryFastPath("关闭客厅空调，打开主卧空调", opts());
      expect(hit!.ttsText).toBe("都没弄成");
    });
  });
