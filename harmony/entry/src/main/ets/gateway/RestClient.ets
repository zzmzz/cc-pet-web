import { http } from '@kit.NetworkKit';

export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized');
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
      const response: http.HttpResponse = await request.request(`${this.baseUrl}${path}`, {
        method: method,
        header: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        extraData: body.length > 0 ? body : undefined,
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 10000,
        readTimeout: 30000,
      });
      if (response.responseCode === 401) {
        throw new UnauthorizedError();
      }
      if (response.responseCode < 200 || response.responseCode >= 300) {
        throw new Error(`http ${response.responseCode}`);
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
}
