import { describe, it, expect } from "vitest";
import { parseSkillCommandsFromSkillsText } from "./parse-skills-probe.js";

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
});
