import { describe, expect, it } from "vitest";
import { segmentForFts, buildMatchQuery, makeSnippet } from "../src/storage/fts.js";

describe("segmentForFts", () => {
  it("splits each CJK character into its own token", () => {
    expect(segmentForFts("搜索").replace(/\s+/g, " ").trim()).toBe("搜 索");
  });

  it("leaves ASCII words intact", () => {
    expect(segmentForFts("hello")).toBe("hello");
  });

  it("segments only the CJK part of mixed text", () => {
    expect(segmentForFts("中文abc").replace(/\s+/g, " ").trim()).toBe("中 文 abc");
  });

  it("handles kana and hangul", () => {
    expect(segmentForFts("あ한").replace(/\s+/g, " ").trim()).toBe("あ 한");
  });
});

describe("buildMatchQuery", () => {
  it("wraps segmented CJK as an adjacent phrase", () => {
    expect(buildMatchQuery("搜索")).toBe('"搜 索"');
  });

  it("returns null for whitespace-only queries", () => {
    expect(buildMatchQuery("   ")).toBeNull();
    expect(buildMatchQuery("")).toBeNull();
  });

  it("escapes embedded double quotes", () => {
    expect(buildMatchQuery('a"b')).toBe('"a""b"');
  });

  it("keeps ASCII words as a phrase", () => {
    expect(buildMatchQuery("hello world")).toBe('"hello world"');
  });
});

describe("makeSnippet", () => {
  it("highlights the first occurrence of the query", () => {
    expect(makeSnippet("全文搜索功能已经上线", "搜索")).toContain("<<hl>>搜索<</hl>>");
  });

  it("is case-insensitive for ASCII", () => {
    expect(makeSnippet("Hello World", "world")).toContain("<<hl>>World<</hl>>");
  });

  it("adds ellipses when context is truncated on both sides", () => {
    const content = `${"x".repeat(50)}目标${"y".repeat(50)}`;
    const snippet = makeSnippet(content, "目标");
    expect(snippet.startsWith("...")).toBe(true);
    expect(snippet.endsWith("...")).toBe(true);
    expect(snippet).toContain("<<hl>>目标<</hl>>");
  });

  it("does not add a leading ellipsis when the match is at the start", () => {
    expect(makeSnippet("目标在开头", "目标").startsWith("...")).toBe(false);
  });

  it("falls back to the head of content when the query is not literally present", () => {
    const snippet = makeSnippet("some content here", "zzz");
    expect(snippet).not.toContain("<<hl>>");
    expect(snippet).toContain("some content");
  });
});
