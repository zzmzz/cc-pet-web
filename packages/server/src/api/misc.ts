import type { FastifyInstance } from "fastify";

export function registerMiscRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { url: string } }>("/api/link-preview", async (req) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return { error: "Missing url param" };

    try {
      const res = await fetch(targetUrl, { signal: AbortSignal.timeout(5000) });
      const html = await res.text();
      const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "";
      const desc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ?? "";
      const image = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i)?.[1] ?? "";
      return { url: targetUrl, title, description: desc, image };
    } catch {
      return { url: targetUrl, title: "", description: "", image: "" };
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
