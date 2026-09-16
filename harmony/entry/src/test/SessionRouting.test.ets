import { describe, it, expect } from '@ohos/hypium';
import {
  sessionFromReplyCtx, resolveIncomingSessionRouting,
  SessionRouteInput, SessionRouteDecision,
} from '../main/ets/logic/sessionRouting';

function input(
  payloadSessionKey?: string, replyCtx?: string,
  knownSessions: string[] = [], activeSessionKey?: string,
): SessionRouteInput {
  return {
    payloadSessionKey: payloadSessionKey,
    replyCtx: replyCtx,
    knownSessions: knownSessions,
    activeSessionKey: activeSessionKey,
  };
}

export default function sessionRoutingTest() {
  describe('sessionFromReplyCtx', () => {
    it('returns null for undefined or empty', 0, () => {
      expect(sessionFromReplyCtx(undefined)).assertNull();
      expect(sessionFromReplyCtx('')).assertNull();
    });

    it('requires the ccpet: prefix', 0, () => {
      expect(sessionFromReplyCtx('other:s1:123')).assertNull();
    });

    it('takes everything before the LAST colon', 0, () => {
      expect(sessionFromReplyCtx('ccpet:s1:123')).assertEqual('s1');
      // A session key containing a colon must survive — this is why the
      // parser uses lastIndexOf, not indexOf.
      expect(sessionFromReplyCtx('ccpet:a:b:123')).assertEqual('a:b');
    });

    it('returns null when there is no trailing colon segment', 0, () => {
      expect(sessionFromReplyCtx('ccpet:s1')).assertNull();
    });
  });

  describe('resolveIncomingSessionRouting', () => {
    it('prefers the payload session key', 0, () => {
      const out: SessionRouteDecision =
        resolveIncomingSessionRouting(input('s1', 'ccpet:s2:9', ['s1', 's2'], 's3'));
      expect(out.sessionKey).assertEqual('s1');
      expect(out.source).assertEqual('payload');
    });

    it('trims the payload key and ignores a blank one', 0, () => {
      expect(resolveIncomingSessionRouting(input('  s1  ')).sessionKey).assertEqual('s1');
      expect(resolveIncomingSessionRouting(input('   ', undefined, [], 'act')).source).assertEqual('active');
    });

    it('falls to replyCtx when the payload has no key', 0, () => {
      const out: SessionRouteDecision =
        resolveIncomingSessionRouting(input(undefined, 'ccpet:s2:9', ['s1', 's2'], 's3'));
      expect(out.sessionKey).assertEqual('s2');
      expect(out.source).assertEqual('reply_ctx');
    });

    it('accepts a replyCtx key when no sessions are known yet', 0, () => {
      const out: SessionRouteDecision =
        resolveIncomingSessionRouting(input(undefined, 'ccpet:s9:1', [], undefined));
      expect(out.sessionKey).assertEqual('s9');
      expect(out.source).assertEqual('reply_ctx');
    });

    it('rejects a replyCtx key that is not among known sessions', 0, () => {
      const out: SessionRouteDecision =
        resolveIncomingSessionRouting(input(undefined, 'ccpet:ghost:1', ['s1'], 's1'));
      expect(out.sessionKey).assertEqual('s1');
      expect(out.source).assertEqual('active');
    });

    it('uses the active session next', 0, () => {
      const out: SessionRouteDecision = resolveIncomingSessionRouting(input(undefined, undefined, ['s1'], 's1'));
      expect(out.source).assertEqual('active');
    });

    it('uses the first known session when nothing is active', 0, () => {
      const out: SessionRouteDecision = resolveIncomingSessionRouting(input(undefined, undefined, ['s7', 's8']));
      expect(out.sessionKey).assertEqual('s7');
      expect(out.source).assertEqual('known');
    });

    it('treats an empty first known session as absent, like web does', 0, () => {
      // Web's branch is `if (knownSessions[0])`, so an empty first key falls
      // through to fallback rather than being returned under 'known'.
      const out: SessionRouteDecision = resolveIncomingSessionRouting(input(undefined, undefined, ['']));
      expect(out.sessionKey).assertEqual('default');
      expect(out.source).assertEqual('fallback');
    });

    it('falls back to default last', 0, () => {
      const out: SessionRouteDecision = resolveIncomingSessionRouting(input());
      expect(out.sessionKey).assertEqual('default');
      expect(out.source).assertEqual('fallback');
    });

    it('honours an explicit fallback key', 0, () => {
      const out: SessionRouteDecision = resolveIncomingSessionRouting({
        knownSessions: [], fallbackSessionKey: 'custom',
      });
      expect(out.sessionKey).assertEqual('custom');
      expect(out.source).assertEqual('fallback');
    });
  });
}
