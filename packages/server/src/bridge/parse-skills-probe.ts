import type { SlashCommand } from "@cc-pet/shared";
import type { BridgeCard } from "@cc-pet/shared";

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

function normalizeCommandName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const stripped = trimmed.startsWith("cmd:") ? trimmed.slice(4).trim() : trimmed;
  if (!stripped.startsWith("/")) return undefined;
  const token = (stripped.split(/\s+/)[0] ?? "").trim();
  if (token.length <= 1) return undefined;
  return token.replace(/^\//, "");
}

export function parseSlashCommandsFromProbeCard(card?: BridgeCard): SlashCommand[] {
  if (!card) return [];

  const out: SlashCommand[] = [];
  const seen = new Set<string>();
  const textChunks: string[] = [];

  for (const el of card.elements ?? []) {
    switch (el.type) {
      case "markdown":
        textChunks.push(el.content);
        break;
      case "list_item":
        textChunks.push(el.text);
        if (el.btn_value) {
          const name = normalizeCommandName(el.btn_value);
          if (name && !seen.has(name)) {
            seen.add(name);
            out.push({
              name,
              description: el.btn_text?.trim() || el.text.trim() || name,
              category: "skill",
              type: "send",
            });
          }
        }
        break;
      case "note":
        textChunks.push(el.text);
        break;
      case "actions":
        for (const btn of el.buttons ?? []) {
          const name = normalizeCommandName(btn.value);
          const key = name?.toLowerCase() ?? "";
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push({
            name: name!,
            description: btn.text?.trim() || name!,
            category: "skill",
            type: "send",
          });
        }
        break;
      case "select":
        for (const opt of el.options ?? []) {
          const name = normalizeCommandName(opt.value);
          const key = name?.toLowerCase() ?? "";
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push({
            name: name!,
            description: opt.text?.trim() || name!,
            category: "skill",
            type: "send",
          });
        }
        break;
      default:
        break;
    }
  }

  const parsedFromText = parseSlashCommandsFromProbeText(textChunks.join("\n"));
  for (const cmd of parsedFromText) {
    const key = cmd.name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(cmd);
  }

  return out;
}

/** 向后兼容：历史命名仍指向同一解析逻辑。 */
export const parseSkillCommandsFromSkillsText = parseSlashCommandsFromProbeText;
