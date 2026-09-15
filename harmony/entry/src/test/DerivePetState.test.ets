import { describe, it, expect } from '@ohos/hypium';
import { derivePetState, PetInputs } from '../main/ets/logic/derivePetState';
import { TaskPhase } from '../main/ets/model/Protocol';

function inputs(phase: string, unread: boolean, connected: boolean, since: number): PetInputs {
  return {
    taskPhase: phase as TaskPhase,
    hasUnread: unread,
    bridgeConnected: connected,
    msSinceConnected: since,
  };
}

export default function derivePetStateTest() {
  describe('derivePetState', () => {
    it('shows error when the bridge is down', 0, () => {
      expect(derivePetState(inputs('idle', false, false, 99999))).assertEqual('error');
    });

    it('error outranks a fresh connection', 0, () => {
      expect(derivePetState(inputs('idle', false, false, 10))).assertEqual('error');
    });

    it('is happy right after connecting', 0, () => {
      expect(derivePetState(inputs('idle', false, true, 500))).assertEqual('happy');
    });

    it('stops being happy after the window closes', 0, () => {
      expect(derivePetState(inputs('idle', false, true, 3001))).assertEqual('idle');
    });

    it('thinks while a task is working', 0, () => {
      expect(derivePetState(inputs('working', false, true, 99999))).assertEqual('thinking');
      expect(derivePetState(inputs('thinking', false, true, 99999))).assertEqual('thinking');
    });

    it('working outranks the happy window', 0, () => {
      expect(derivePetState(inputs('working', false, true, 100))).assertEqual('thinking');
    });

    it('talks when unread messages are waiting', 0, () => {
      expect(derivePetState(inputs('completed', true, true, 99999))).assertEqual('talking');
    });

    it('falls back to idle', 0, () => {
      expect(derivePetState(inputs('completed', false, true, 99999))).assertEqual('idle');
    });
  });
}
