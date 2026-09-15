import { SlashCommandSpec, SlashCommandCategory } from '../model/Protocol';

export const BUILTIN_COMMANDS: SlashCommandSpec[] = [
  { command: '/clear', description: '清空聊天记录', category: 'builtin', type: 'local' },
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
