import { describe, it, expect } from "vitest";
import { urlBase64ToUint8Array } from "./push.js";

describe("urlBase64ToUint8Array", () => {
  it("decodes URL-safe base64 VAPID key to bytes", () => {
    // "hello" standard base64 is aGVsbG8=; URL-safe unpadded: aGVsbG8
    const bytes = urlBase64ToUint8Array("aGVsbG8");
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]);
  });
});
