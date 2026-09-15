import localUnitTest from './LocalUnit.test';
import backoffTest from './Backoff.test';

export default function testsuite() {
  localUnitTest();
  backoffTest();
}
