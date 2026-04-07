import { describe, it, expect } from "vitest";
import { parseSkillCommandsFromSkillsText, parseSlashCommandsFromProbeCard } from "./parse-skills-probe.js";

describe("parseSkillCommandsFromSkillsText", () => {
  it("parses lines like cc-pet /skills output", () => {
    const text = `/alpha — first skill
/beta - second one
`;
    const cmds = parseSkillCommandsFromSkillsText(text);
    expect(cmds.map((c) => ({ name: c.name, description: c.description }))).toEqual([
      { name: "alpha", description: "first skill" },
      { name: "beta", description: "second one" },
    ]);
  });

  it("skips duplicate commands and lines without description", () => {
    const text = `/dup — one
/dup — ignored
/bar
`;
    const cmds = parseSkillCommandsFromSkillsText(text);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].name).toBe("dup");
  });

  it("parses slash commands from card elements and cmd values", () => {
    const cmds = parseSlashCommandsFromProbeCard({
      header: { title: "技能列表" },
      elements: [
        { type: "markdown", content: "/alpha — from markdown\n/beta - from md" },
        {
          type: "actions",
          buttons: [
            { text: "发送 gamma", value: "cmd:/gamma" },
            { text: "发送 delta", value: "/delta" },
          ],
        },
        {
          type: "list_item",
          text: "列表项说明",
          btn_text: "执行 epsilon",
          btn_value: "cmd:/epsilon",
        },
        {
          type: "select",
          options: [
            { text: "执行 zeta", value: "cmd:/zeta" },
            { text: "无效项", value: "hello" },
          ],
        },
      ],
    });
    expect(cmds.map((c) => c.name)).toEqual(["gamma", "delta", "epsilon", "zeta", "alpha", "beta"]);
  });
});
