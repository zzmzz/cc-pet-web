import type { SlashCommand } from "@cc-pet/shared";

/**
 * 与 cc-pet `parse_skill_commands_from_text` 对齐：从 `/skills` 返回的纯文本解析可补全的斜杠命令。
 */
export function parseSlashCommandsFromProbeText(text: string): SlashCommand[] {
  const out: SlashCommand[] = [];
  const seen = new Set<string>();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("/")) continue;

    const commandToken = (trimmed.split(/\s/)[0] ?? "").trim();
    if (
      commandToken.length <= 1 ||
      commandToken.includes("<") ||
      commandToken.includes(">") ||
      commandToken.includes("[") ||
      commandToken.includes("]")
    ) {
      continue;
    }

    let rest = trimmed.slice(commandToken.length).trim();
    rest = rest.replace(/^[\u2014\u2013\-:]+/, "").trim();

    if (!rest) continue;

    const key = commandToken.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      name: commandToken.replace(/^\//, ""),
      description: rest,
      category: "skill",
      type: "send",
    });
  }

  return out;
}

/** 向后兼容：历史命名仍指向同一解析逻辑。 */
export const parseSkillCommandsFromSkillsText = parseSlashCommandsFromProbeText;
