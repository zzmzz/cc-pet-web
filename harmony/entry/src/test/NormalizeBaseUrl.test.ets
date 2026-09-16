import { describe, it, expect } from '@ohos/hypium';
import { normalizeBaseUrl, BaseUrlResult } from '../main/ets/shell/normalizeBaseUrl';

/**
 * The shell has exactly one piece of logic that is not a device behaviour,
 * and this is it. Everything else in `ets/shell` either touches preferences,
 * the network, or an `@Entry` struct, none of which `hvigorw test` can reach.
 */
export default function normalizeBaseUrlTest() {
  describe('normalizeBaseUrl', () => {
    it('defaults a bare host to https, not http', 0, () => {
      const result: BaseUrlResult = normalizeBaseUrl('cc-pet.example.com');
      expect(result.url).assertEqual('https://cc-pet.example.com');
      expect(result.error).assertEqual('');
    });

    it('keeps an explicit http scheme (how the local fixture stack is reachable)', 0, () => {
      expect(normalizeBaseUrl('http://127.0.0.1:19311').url).assertEqual('http://127.0.0.1:19311');
    });

    it('trims surrounding whitespace', 0, () => {
      expect(normalizeBaseUrl('  https://a.example  ').url).assertEqual('https://a.example');
    });

    it('strips trailing slashes so paths never become //api/...', 0, () => {
      expect(normalizeBaseUrl('https://a.example///').url).assertEqual('https://a.example');
      expect(normalizeBaseUrl('a.example/').url).assertEqual('https://a.example');
    });

    it('keeps a sub-path mount point', 0, () => {
      expect(normalizeBaseUrl('https://a.example/cc-pet/').url).assertEqual('https://a.example/cc-pet');
    });

    it('lowercases the scheme', 0, () => {
      expect(normalizeBaseUrl('HTTPS://A.example').url).assertEqual('https://A.example');
    });

    it('rejects empty input', 0, () => {
      const result: BaseUrlResult = normalizeBaseUrl('   ');
      expect(result.url).assertEqual('');
      expect(result.error).assertEqual('请输入服务器地址');
    });

    it('rejects a scheme it cannot load', 0, () => {
      expect(normalizeBaseUrl('ftp://a.example').error).assertEqual('只支持 http:// 或 https:// 地址');
      expect(normalizeBaseUrl('file:///etc/passwd').error).assertEqual('只支持 http:// 或 https:// 地址');
    });

    it('rejects a scheme with nothing after it', 0, () => {
      expect(normalizeBaseUrl('https://').error).assertEqual('地址缺少主机名');
    });

    it('rejects an embedded space rather than producing an unloadable url', 0, () => {
      expect(normalizeBaseUrl('https://a.example/my app').error).assertEqual('地址不能包含空格');
    });
  });
}
