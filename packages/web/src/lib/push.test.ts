import { describe, it, expect } from "vitest";
import { setPlatform, type PlatformAPI } from "./platform.js";
import { getVapidPublicKey, urlBase64ToUint8Array } from "./push.js";

describe("urlBase64ToUint8Array", () => {
  it("decodes URL-safe base64 VAPID key to bytes", () => {
    // "hello" standard base64 is aGVsbG8=; URL-safe unpadded: aGVsbG8
    const bytes = urlBase64ToUint8Array("aGVsbG8");
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]);
  });
});

function fakePlatform(fetchApi: PlatformAPI["fetchApi"]): PlatformAPI {
  return {
    connectWs: () => {},
    disconnectWs: () => {},
    onWsEvent: () => () => {},
    sendWsMessage: () => {},
    fetchApi,
    fetchApiRaw: async () => {
      throw new Error("not implemented");
    },
  };
}

describe("getVapidPublicKey", () => {
  it("returns the server public key when the platform resolves it", async () => {
    setPlatform(fakePlatform(async () => ({ publicKey: "PUB" }) as any));
    await expect(getVapidPublicKey()).resolves.toBe("PUB");
  });

  it("returns null when the platform fetch rejects", async () => {
    setPlatform(
      fakePlatform(async () => {
        throw new Error("network error");
      }),
    );
    await expect(getVapidPublicKey()).resolves.toBeNull();
  });
});
