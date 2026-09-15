import { describe, it, expect } from '@ohos/hypium';
import { isRenderableImageHref, imageFallbackText } from '../main/ets/logic/markdownImage';
import { MdSpan } from '../main/ets/model/Markdown';

function imageSpan(text: string, href: string): MdSpan {
  return { kind: 'image', text: text, href: href };
}

/**
 * Image receive/preview is out of first-release scope, so the requirement
 * these two cover is only "never render a markdown image as nothing".
 */
export default function markdownImageTest() {
  describe('isRenderableImageHref', () => {
    it('accepts absolute http(s) urls', 0, () => {
      expect(isRenderableImageHref('https://example.com/a.png')).assertTrue();
      expect(isRenderableImageHref('http://example.com/a.png')).assertTrue();
    });

    it('rejects the server-relative form cc-pet actually emits', 0, () => {
      // Needs both an origin ImageSpan does not have and the bearer header
      // ImageSpan cannot attach.
      expect(isRenderableImageHref('/api/files/abc')).assertFalse();
    });

    it('rejects an empty href and other unresolvable schemes', 0, () => {
      expect(isRenderableImageHref('')).assertFalse();
      expect(isRenderableImageHref('./local.png')).assertFalse();
      expect(isRenderableImageHref('file:///tmp/a.png')).assertFalse();
    });
  });

  describe('imageFallbackText', () => {
    it('uses the markdown alt text when the author wrote one', 0, () => {
      expect(imageFallbackText(imageSpan('流程图', '/api/files/abc'))).assertEqual('[图片: 流程图]');
    });

    it('falls back to a bare marker for an empty or blank alt', 0, () => {
      expect(imageFallbackText(imageSpan('', '/api/files/abc'))).assertEqual('[图片]');
      expect(imageFallbackText(imageSpan('   ', '/api/files/abc'))).assertEqual('[图片]');
    });
  });
}
