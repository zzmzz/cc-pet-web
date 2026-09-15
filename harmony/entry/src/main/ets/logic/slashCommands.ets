import { SlashCommandSpec, SlashCommandCategory } from '../model/Protocol';

export const BUILTIN_COMMANDS: SlashCommandSpec[] = [
  // Description, not behaviour: `/clear` only drops the local view (see
  // `MessageInput.runLocal`), and the server still has every message.
  { command: '/clear', description: '清空本地视图（重连后恢复）', category: 'builtin', type: 'local' },
  { command: '/settings', description: '打开设置面板', category: 'builtin', type: 'local' },
  { command: '/connect', description: '连接 cc-connect Bridge', category: 'builtin', type: 'local' },
  { command: '/disconnect', description: '断开 cc-connect Bridge', category: 'builtin', type: 'local' },
];

export const CC_CONNECT_COMMANDS: SlashCommandSpec[] = [
  { command: '/new', description: '开始新会话 /new [name]', category: 'session', type: 'send' },
  { command: '/list', description: '列出所有会话', category: 'session', type: 'send' },
  { command: '/switch', description: '切换会话 /switch <id>', category: 'session', type: 'send' },
  { command: '/current', description: '当前会话信息', category: 'session', type: 'send' },
  { command: '/history', description: '查看最近消息 /history [n]', category: 'session', type: 'send' },
  { command: '/stop', description: '停止当前执行', category: 'session', type: 'send' },
  { command: '/model', description: '查看/切换模型 /model [switch <alias>]', category: 'agent', type: 'send' },
  { command: '/mode', description: '查看/切换权限模式 /mode [yolo|default|plan]', category: 'agent', type: 'send' },
  { command: '/reasoning', description: '调整推理级别 /reasoning [level]', category: 'agent', type: 'send' },
];

const CATEGORY_ORDER: SlashCommandCategory[] = ['builtin', 'session', 'agent', 'skill'];

/**
 * Strictly a LEADING slash — no `trimStart()`. That is deliberate (planned
 * behaviour, Task 8: `isSlashInput(' /mo') === false`), and it is also the
 * single most expensive line in this file to misread.
 *
 * ---------------------------------------------------------------------------
 * "The slash palette never renders on the emulator" — it does. Read this
 * before you change anything here or in SlashCommandMenu/MessageInput.
 * ---------------------------------------------------------------------------
 * `uitest uiInput inputText <x> <y> <text>` — the command behind
 * `ui_type_at` in `harmony/scripts/lib/common.sh`, which every existing
 * device probe types with — PREPENDS A SPACE to the text it injects.
 * Measured on the emulator, dumped TextArea `text` attribute before -> after,
 * starting from a genuinely empty field:
 *
 *     ''  --inputText "abc"-->  ' abc'
 *     ''  --inputText "/cl"-->  ' /cl'
 *
 * So a probe that "types /cl" through `ui_type_at` actually hands this
 * function `' /cl'`, which correctly returns false, and the palette
 * correctly stays closed. That — not an ArkUI V2 reactivity failure, not
 * `$$this.text`, not the `Scroll`-vs-`List` shape — is the whole of the bug
 * report that claimed slash commands were dead in this release. Proven
 * causally on-device: with `' /cl'` in the field and zero palette rows,
 * deleting ONLY the leading space (MOVE_HOME then FORWARD_DEL, nothing else
 * touched) made `/clear` appear immediately.
 *
 * Type through `uitest uiInput text <text>` (IME commit into the focused
 * field) or `uitest uiInput keyEvent <code>` instead; both inject the exact
 * string. `harmony/scripts/device-slash-palette-probe.sh` does this and
 * asserts the palette opens, narrows and closes.
 *
 * Known, accepted divergence from the reference client: `packages/web`'s
 * `useSlashMenu` does `input.trimStart().startsWith("/")`, i.e. it tolerates
 * leading whitespace. This one does not, per the plan. Left as-is on purpose
 * — changing it would paper over the probing mistake above and would silently
 * rewrite a pinned, planned assertion. If a real user is ever observed
 * wanting `' /clear'` to open the palette, that is a product decision to take
 * deliberately, not a bug to sneak in while chasing a phantom.
 */
export function isSlashInput(input: string): boolean {
  return input.startsWith('/');
}

/** Builtins win on collision so a skill cannot shadow /clear. */
export function mergeCommands(skills: SlashCommandSpec[]): SlashCommandSpec[] {
  const merged: SlashCommandSpec[] = [];
  const seen: Set<string> = new Set<string>();
  const staticCommands: SlashCommandSpec[] = BUILTIN_COMMANDS.concat(CC_CONNECT_COMMANDS);
  for (const spec of staticCommands) {
    merged.push(spec);
    seen.add(spec.command);
  }
  for (const spec of skills) {
    if (!seen.has(spec.command)) {
      merged.push(spec);
      seen.add(spec.command);
    }
  }
  return merged;
}

export function matchCommands(all: SlashCommandSpec[], input: string): SlashCommandSpec[] {
  if (!isSlashInput(input)) {
    return [];
  }
  const token: string = (input.split(' ')[0] ?? input).toLowerCase();
  const hits: SlashCommandSpec[] = [];
  for (const spec of all) {
    if (spec.command.toLowerCase().startsWith(token)) {
      hits.push(spec);
    }
  }
  hits.sort((a: SlashCommandSpec, b: SlashCommandSpec): number => {
    const byCategory: number = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    return byCategory !== 0 ? byCategory : a.command.localeCompare(b.command);
  });
  return hits;
}
