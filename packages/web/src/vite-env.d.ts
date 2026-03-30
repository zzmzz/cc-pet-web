/// <reference types="vite/client" />

declare module "@tauri-apps/api/core" {
  export function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

declare module "react-syntax-highlighter/dist/esm/styles/prism/index.js" {
  import type { CSSProperties } from "react";
  export const oneDark: Record<string, CSSProperties>;
}
