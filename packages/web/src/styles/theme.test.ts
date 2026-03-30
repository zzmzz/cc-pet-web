import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("theme tokens", () => {
  it("uses light surface colors", () => {
    const cssPath = path.resolve(import.meta.dirname, "./globals.css");
    const css = fs.readFileSync(cssPath, "utf8");

    expect(css).toContain("--color-surface: #f8fafc;");
    expect(css).toContain("--color-surface-secondary: #ffffff;");
    expect(css).toContain("--color-surface-tertiary: #f3f4f6;");
    expect(css).toContain("--color-border: #e5e7eb;");
  });
});
