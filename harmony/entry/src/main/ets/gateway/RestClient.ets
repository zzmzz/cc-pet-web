import { http } from '@kit.NetworkKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { buildRequestHeaders } from './RequestHeaders';

const DOMAIN = 0x0000;
const TAG = 'RestClient';

export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized');
  }
}

/**
 * Thrown when `request.request()` itself fails — before any HTTP response was
 * received (synchronous parameter rejection, DNS/connect failure, TLS error,
 * timeout, etc). `code` is the ArkTS/NetStack `BusinessError.code`, NOT an
 * HTTP status code. See @ohos.net.http.d.ts for the code table (e.g. 401 =
 * "Parameter error", 2300006 = "Failed to resolve the host name", 2300007 =
 * "Failed to connect to the server").
 */
export class NetworkError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** Only layer that talks HTTP. UI never imports this directly. */
export class RestClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  private async request(path: string, method: http.RequestMethod, body: string): Promise<string> {
    const request: http.HttpRequest = http.createHttp();
    try {
      const url: string = `${this.baseUrl}${path}`;
      let response: http.HttpResponse;
      try {
        response = await request.request(url, {
          method: method,
          header: buildRequestHeaders(this.token, body),
          extraData: body.length > 0 ? body : undefined,
          expectDataType: http.HttpDataType.STRING,
          connectTimeout: 10000,
          readTimeout: 30000,
        });
      } catch (err) {
        const businessError: BusinessError = err as BusinessError;
        hilog.error(DOMAIN, TAG, 'request.request() rejected before any network attempt: url=%{public}s code=%{public}d message=%{public}s',
          url, businessError.code, businessError.message);
        throw new NetworkError(businessError.code, businessError.message);
      }
      if (response.responseCode === 401) {
        throw new UnauthorizedError();
      }
      if (response.responseCode < 200 || response.responseCode >= 300) {
        hilog.error(DOMAIN, TAG, 'unexpected http status: url=%{public}s status=%{public}d', url, response.responseCode);
        throw new NetworkError(response.responseCode, `http ${response.responseCode}`);
      }
      return response.result as string;
    } finally {
      request.destroy();
    }
  }

  getJson(path: string): Promise<string> {
    return this.request(path, http.RequestMethod.GET, '');
  }

  postJson(path: string, body: string): Promise<string> {
    return this.request(path, http.RequestMethod.POST, body);
  }

  deleteJson(path: string): Promise<string> {
    return this.request(path, http.RequestMethod.DELETE, '');
  }

  /**
   * Binary GET — for `Endpoints.PET_IMAGE` (and anything else that isn't
   * JSON). Kept separate from `request()` above rather than generalizing it:
   * `request()`'s `expectDataType: STRING` and its `Content-Type:
   * application/json` header only make sense for the JSON callers, and
   * threading a data-type parameter through just for one binary caller
   * wasn't worth the churn to the existing (working, tested-via-Task-11/12)
   * JSON path.
   */
  async getBinary(path: string): Promise<ArrayBuffer> {
    const request: http.HttpRequest = http.createHttp();
    try {
      const url: string = `${this.baseUrl}${path}`;
      let response: http.HttpResponse;
      try {
        response = await request.request(url, {
          method: http.RequestMethod.GET,
          header: {
            'Authorization': `Bearer ${this.token}`,
          },
          expectDataType: http.HttpDataType.ARRAY_BUFFER,
          connectTimeout: 10000,
          readTimeout: 30000,
        });
      } catch (err) {
        const businessError: BusinessError = err as BusinessError;
        hilog.error(DOMAIN, TAG, 'getBinary request.request() rejected before any network attempt: url=%{public}s code=%{public}d message=%{public}s',
          url, businessError.code, businessError.message);
        throw new NetworkError(businessError.code, businessError.message);
      }
      if (response.responseCode === 401) {
        throw new UnauthorizedError();
      }
      if (response.responseCode < 200 || response.responseCode >= 300) {
        hilog.info(DOMAIN, TAG, 'getBinary non-2xx (expected for a token with no custom image): url=%{public}s status=%{public}d', url, response.responseCode);
        throw new NetworkError(response.responseCode, `http ${response.responseCode}`);
      }
      return response.result as ArrayBuffer;
    } finally {
      request.destroy();
    }
  }
}
