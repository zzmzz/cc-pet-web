import { describe, expect, it } from "vitest";
import { splitUsageFooter } from "./footer.js";

describe("splitUsageFooter", () => {
  it("strips the usage footer and returns it separately", () => {
    const content =
      "下载在后台跑，大概十几分钟完成。\n\n*us.anthropic.claude-opus-4-8 · out 3.0k · in 2 cw 1.9k cr 78.8k · ctx 40%\n.*";
    const { body, footer, model } = splitUsageFooter(content);
    expect(body).toBe("下载在后台跑，大概十几分钟完成。");
    expect(footer).toContain("us.anthropic.claude-opus-4-8");
    expect(footer).toContain("ctx 40%");
    expect(model).toBe("opus-4-8");
  });

  it("derives a short model name from the footer", () => {
    expect(splitUsageFooter("hi\n\n*us.anthropic.claude-opus-4-8 · ctx 1%*").model).toBe("opus-4-8");
    expect(splitUsageFooter("hi\n\n*anthropic.claude-sonnet-4-6 · ctx 1%*").model).toBe("sonnet-4-6");
    expect(splitUsageFooter("hi\n\n*claude-haiku-4-5-20251001 · ctx 1%*").model).toBe("haiku-4-5");
  });

  it("returns null model when no footer present", () => {
    expect(splitUsageFooter("just a reply").model).toBeNull();
  });

  it("handles single-line footer", () => {
    const content = "Hi! What can I help you with today?\n\n*us.anthropic.claude-opus-4-8 · out 22 · in 5.4k cw 21.7k cr 0 · ctx 14%*";
    const { body, footer } = splitUsageFooter(content);
    expect(body).toBe("Hi! What can I help you with today?");
    expect(footer).toContain("ctx 14%");
  });

  it("returns null footer when no usage footer present", () => {
    const content = "just a normal reply";
    const { body, footer } = splitUsageFooter(content);
    expect(body).toBe("just a normal reply");
    expect(footer).toBeNull();
  });

  it("does not strip an asterisk emphasis that is not a usage footer", () => {
    const content = "速度 *24 MB/s* 很稳定";
    const { body, footer } = splitUsageFooter(content);
    expect(body).toBe(content);
    expect(footer).toBeNull();
  });
});
