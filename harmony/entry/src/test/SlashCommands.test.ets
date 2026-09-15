import { describe, it, expect } from '@ohos/hypium';
import {
  BUILTIN_COMMANDS, CC_CONNECT_COMMANDS, mergeCommands, matchCommands, isSlashInput,
} from '../main/ets/logic/slashCommands';
import { SlashCommandSpec } from '../main/ets/model/Protocol';

function skill(command: string): SlashCommandSpec {
  return { command: command, description: 'from skills', category: 'skill', type: 'send' };
}

export default function slashCommandsTest() {
  describe('isSlashInput', () => {
    it('is true only for a leading slash', 0, () => {
      expect(isSlashInput('/mo')).assertEqual(true);
      expect(isSlashInput(' /mo')).assertEqual(false);
      expect(isSlashInput('hello /mo')).assertEqual(false);
      expect(isSlashInput('')).assertEqual(false);
    });
  });

  describe('mergeCommands', () => {
    it('includes builtins, cc-connect commands and skills', 0, () => {
      const merged: SlashCommandSpec[] = mergeCommands([skill('/deploy')]);
      expect(merged.length).assertEqual(BUILTIN_COMMANDS.length + CC_CONNECT_COMMANDS.length + 1);
    });

    it('drops skills that collide with a builtin', 0, () => {
      const merged: SlashCommandSpec[] = mergeCommands([skill('/clear')]);
      expect(merged.length).assertEqual(BUILTIN_COMMANDS.length + CC_CONNECT_COMMANDS.length);
    });
  });

  describe('matchCommands', () => {
    it('filters by prefix', 0, () => {
      const all: SlashCommandSpec[] = mergeCommands([]);
      const hits: SlashCommandSpec[] = matchCommands(all, '/cl');
      expect(hits.length).assertEqual(1);
      expect(hits[0].command).assertEqual('/clear');
    });

    it('returns everything for a bare slash', 0, () => {
      const all: SlashCommandSpec[] = mergeCommands([]);
      expect(matchCommands(all, '/').length).assertEqual(all.length);
    });

    it('ignores anything after the first space', 0, () => {
      const all: SlashCommandSpec[] = mergeCommands([]);
      expect(matchCommands(all, '/model switch x').length).assertEqual(1);
    });

    it('is case insensitive', 0, () => {
      const all: SlashCommandSpec[] = mergeCommands([]);
      expect(matchCommands(all, '/CL')[0].command).assertEqual('/clear');
    });

    it('returns empty when nothing matches', 0, () => {
      const all: SlashCommandSpec[] = mergeCommands([]);
      expect(matchCommands(all, '/zzz').length).assertEqual(0);
    });

    it('orders builtin before session before agent before skill', 0, () => {
      const all: SlashCommandSpec[] = mergeCommands([skill('/aaa')]);
      const hits: SlashCommandSpec[] = matchCommands(all, '/');
      expect(hits[0].category).assertEqual('builtin');
      expect(hits[hits.length - 1].category).assertEqual('skill');
    });
  });
}
