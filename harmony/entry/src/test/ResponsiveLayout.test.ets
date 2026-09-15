import { describe, it, expect } from '@ohos/hypium';
import { ResponsiveLayout, ResponsiveWidthClass } from '../main/ets/components/ResponsiveLayout';

export default function responsiveLayoutTest() {
  describe('ResponsiveLayout', () => {
    it('classifies the three width bands', 0, () => {
      expect(ResponsiveLayout.widthClass(599)).assertEqual(ResponsiveWidthClass.COMPACT);
      expect(ResponsiveLayout.widthClass(600)).assertEqual(ResponsiveWidthClass.MEDIUM);
      expect(ResponsiveLayout.widthClass(839)).assertEqual(ResponsiveWidthClass.MEDIUM);
      expect(ResponsiveLayout.widthClass(840)).assertEqual(ResponsiveWidthClass.EXPANDED);
    });

    it('uses side sessions from medium up', 0, () => {
      expect(ResponsiveLayout.usesSideSessions(599)).assertEqual(false);
      expect(ResponsiveLayout.usesSideSessions(600)).assertEqual(true);
    });

    it('caps content width only when expanded', 0, () => {
      expect(ResponsiveLayout.contentMaxWidth(500)).assertEqual(500);
      expect(ResponsiveLayout.contentMaxWidth(2000)).assertEqual(1240);
    });
  });
}
