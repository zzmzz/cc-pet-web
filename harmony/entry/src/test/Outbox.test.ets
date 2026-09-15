import { describe, it, expect } from '@ohos/hypium';
import { Outbox, OutboxEntry, ACK_TIMEOUT_MS, MANUAL_WINDOW_MS } from '../main/ets/logic/outbox';

export default function outboxTest() {
  describe('Outbox', () => {
    it('enqueues as pending and reports size', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'auto', 1000);
      expect(box.size()).assertEqual(1);
      expect(box.entriesOf('c::s')[0].status).assertEqual('pending');
    });

    it('drops an entry once acked', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'auto', 1000);
      box.markSent('id-a');
      expect(box.size()).assertEqual(0);
    });

    it('fails entries whose ack budget expired', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'auto', 1000);
      box.markTransmitted(['id-a'], 1000);
      const expired: string[] = box.expireTimedOut(1000 + ACK_TIMEOUT_MS + 1);
      expect(expired.length).assertEqual(1);
      expect(expired[0]).assertEqual('id-a');
      expect(box.entriesOf('c::s')[0].status).assertEqual('failed');
    });

    it('does not expire an entry that was never transmitted', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'auto', 1000);
      expect(box.expireTimedOut(1000 + ACK_TIMEOUT_MS + 1).length).assertEqual(0);
    });

    it('restarts the ack budget on retransmit', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'auto', 1000);
      box.markTransmitted(['id-a'], 1000);
      box.markTransmitted(['id-a'], 50000);
      expect(box.expireTimedOut(50000 + ACK_TIMEOUT_MS - 1).length).assertEqual(0);
      expect(box.expireTimedOut(50000 + ACK_TIMEOUT_MS + 1).length).assertEqual(1);
    });

    it('keeps createdAt fixed across retransmits so manual entries still age out', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'manual', 1000);
      box.markTransmitted(['id-a'], 1000);
      box.markTransmitted(['id-a'], 1000 + MANUAL_WINDOW_MS - 1);
      expect(box.entriesOf('c::s')[0].createdAt).assertEqual(1000);
      expect(box.takeSendable(1000 + MANUAL_WINDOW_MS + 1).length).assertEqual(0);
    });

    it('offers manual entries only inside the window', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'manual', 1000);
      expect(box.takeSendable(1000 + MANUAL_WINDOW_MS - 1).length).assertEqual(1);
      expect(box.takeSendable(1000 + MANUAL_WINDOW_MS + 1).length).assertEqual(0);
    });

    it('never offers never-policy entries for auto resend', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'never', 1000);
      expect(box.takeSendable(1001).length).assertEqual(0);
    });

    it('offers auto entries regardless of age', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'auto', 1000);
      expect(box.takeSendable(99999999).length).assertEqual(1);
    });

    it('returns entries in enqueue order', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'first', 'auto', 1000);
      box.enqueue('id-b', 'c::s', 'second', 'auto', 1001);
      const sendable: OutboxEntry[] = box.takeSendable(2000);
      expect(sendable[0].clientMsgId).assertEqual('id-a');
      expect(sendable[1].clientMsgId).assertEqual('id-b');
    });

    it('revives one failed entry on explicit resend', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'manual', 1000);
      box.markTransmitted(['id-a'], 1000);
      box.expireTimedOut(1000 + ACK_TIMEOUT_MS + 1);
      box.resend('id-a', 99999999);
      expect(box.entriesOf('c::s')[0].status).assertEqual('pending');
      expect(box.takeSendable(99999999).length).assertEqual(1);
    });

    it('does not offer a failed entry until something revives it', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'auto', 1000);
      box.markTransmitted(['id-a'], 1000);
      box.expireTimedOut(1000 + ACK_TIMEOUT_MS + 1);
      expect(box.takeSendable(99999999).length).assertEqual(0);
    });

    it('fails a manual entry that outlived its window', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'manual', 1000);
      box.takeSendable(1000 + MANUAL_WINDOW_MS + 1);
      expect(box.entriesOf('c::s')[0].status).assertEqual('failed');
    });

    it('revives failed auto entries on reconnect', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'auto', 1000);
      box.markTransmitted(['id-a'], 1000);
      box.expireTimedOut(1000 + ACK_TIMEOUT_MS + 1);
      box.reviveAuto();
      expect(box.entriesOf('c::s')[0].status).assertEqual('pending');
      expect(box.takeSendable(99999999).length).assertEqual(1);
    });

    it('leaves failed manual entries for the user to retry', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'manual', 1000);
      box.markTransmitted(['id-a'], 1000);
      box.expireTimedOut(1000 + ACK_TIMEOUT_MS + 1);
      box.reviveAuto();
      expect(box.entriesOf('c::s')[0].status).assertEqual('failed');
    });

    it('ignores duplicate client message ids', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'auto', 1000);
      box.enqueue('id-a', 'c::s', 'hello again', 'auto', 2000);
      expect(box.size()).assertEqual(1);
    });
  });
}
