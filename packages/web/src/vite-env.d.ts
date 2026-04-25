/// <reference types="vite/client" />

declare const __BUILD_TIME__: string;

declare module "react-syntax-highlighter/dist/esm/styles/prism/index.js" {
  import type { CSSProperties } from "react";
  export const oneDark: Record<string, CSSProperties>;
}
