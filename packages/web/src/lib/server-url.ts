/** Tauri 下覆盖 HTTP/WS 基础地址；留空则与内置页面同源。 */
export const CC_PET_SERVER_URL_KEY = "cc-pet-server-url";

export function getTauriServerBaseUrl(): string {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(CC_PET_SERVER_URL_KEY)?.trim() ?? "";
}

/** 浏览器同源或 Tauri 下自定义服务根地址 + path（如 `/api/auth/verify`）。 */
export function resolveApiUrl(path: string): string {
  const base = getTauriServerBaseUrl();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (!base) return normalizedPath;
  return `${base.replace(/\/$/, "")}${normalizedPath}`;
}
