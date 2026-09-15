import localUnitTest from './LocalUnit.test';
import backoffTest from './Backoff.test';
import normalizeEventTest from './NormalizeEvent.test';

export default function testsuite() {
  localUnitTest();
  backoffTest();
  normalizeEventTest();
}
