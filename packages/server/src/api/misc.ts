import type { FastifyInstance } from "fastify";

export function registerMiscRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { url: string } }>("/api/link-preview", async (req) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return { error: "Missing url param" };

    try {
      const res = await fetch(targetUrl, { signal: AbortSignal.timeout(5000) });
      const contentType = res.headers.get("content-type")?.toLowerCase() ?? "";
      const contentDisposition = res.headers.get("content-disposition") ?? "";
      const finalUrl = res.url || targetUrl;
      const parsedFinal = tryParseUrl(finalUrl);
      const fileNameFromHeader = parseFileNameFromContentDisposition(contentDisposition);
      const fileName = fileNameFromHeader || (parsedFinal ? inferFileNameFromUrl(parsedFinal) : "");
      const isFile =
        contentDisposition.toLowerCase().includes("attachment")
        || fileName.length > 0
        || (!contentType.includes("text/html") && !contentType.includes("application/xhtml"));
      if (isFile) {
        return {
          url: targetUrl,
          finalUrl,
          title: fileName || "",
          description: "",
          image: "",
          isFile: true,
          fileName: fileName || undefined,
        };
      }
      const html = await res.text();
      const title = (
        html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i)?.[1]
        ?? html.match(/<meta[^>]*name=["']twitter:title["'][^>]*content=["']([^"']*)["']/i)?.[1]
        ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]
        ?? ""
      ).trim();
      const desc = (
        html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1]
        ?? html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1]
        ?? ""
      ).trim();
      const image = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i)?.[1] ?? "";
      return {
        url: targetUrl,
        finalUrl,
        title,
        description: desc,
        image,
        isFile,
        fileName: fileName || undefined,
      };
    } catch {
      return { url: targetUrl, finalUrl: targetUrl, title: "", description: "", image: "", isFile: false };
    }
  });

  app.get("/api/update-check", async () => {
    try {
      const res = await fetch("https://api.github.com/repos/zzmzz/cc-pet-web/releases/latest", {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { hasUpdate: false };
      const data = await res.json() as any;
      return { hasUpdate: true, version: data.tag_name, url: data.html_url };
    } catch {
      return { hasUpdate: false };
    }
  });
}

function tryParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function inferFileNameFromUrl(url: URL): string {
  const raw = decodeURIComponent(url.pathname.split("/").pop() || "").trim();
  if (!raw) return "";
  return raw.includes(".") ? raw : "";
}

function parseFileNameFromContentDisposition(value: string): string {
  if (!value) return "";
  for (const part of value.split(";")) {
    const p = part.trim();
    if (p.toLowerCase().startsWith("filename*=")) {
      const encoded = p.slice("filename*=".length).trim().replace(/^UTF-8''/i, "").replace(/^["']|["']$/g, "");
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    }
    if (p.toLowerCase().startsWith("filename=")) {
      return p.slice("filename=".length).trim().replace(/^["']|["']$/g, "");
    }
  }
  return "";
}
