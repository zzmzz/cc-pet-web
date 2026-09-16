import { describe, it, expect } from '@ohos/hypium';
import { serializeStringMap, deserializeStringMap } from '../main/ets/logic/sessionMaps';

export default function sessionMapsTest() {
  describe('session map persistence', () => {
    it('round-trips a map', 0, () => {
      const m: Map<string, string> = new Map<string, string>();
      m.set('c1', 's1');
      m.set('c2', 's2');
      const back: Map<string, string> = deserializeStringMap(serializeStringMap(m));
      expect(back.get('c1')).assertEqual('s1');
      expect(back.get('c2')).assertEqual('s2');
      expect(back.size).assertEqual(2);
    });

    it('survives an empty map', 0, () => {
      expect(deserializeStringMap(serializeStringMap(new Map<string, string>())).size).assertEqual(0);
    });

    it('returns an empty map for garbage rather than throwing', 0, () => {
      expect(deserializeStringMap('not json').size).assertEqual(0);
      expect(deserializeStringMap('').size).assertEqual(0);
      expect(deserializeStringMap('[1,2,3]').size).assertEqual(0);
    });

    it('drops non-string values instead of importing them', 0, () => {
      expect(deserializeStringMap('{"c1":"s1","c2":5}').get('c1')).assertEqual('s1');
      expect(deserializeStringMap('{"c1":"s1","c2":5}').size).assertEqual(1);
    });
  });
}
