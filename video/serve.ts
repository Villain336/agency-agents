// Serves the video/ pages and proxies /api/* to a Weave server, injecting the token (so pages never see it).
//   node video/serve.ts [port=8800] [weaveUrl=http://localhost:8789] [token=test-admin-token]
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const [port = "8800", target = "http://localhost:8789", token = "test-admin-token"] = process.argv.slice(2);
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  if (u.pathname.startsWith("/api/")) {
    const r = await fetch(target + u.pathname + u.search, { method: req.method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }).catch((e) => new Response(String(e), { status: 502 }));
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
    return void res.end(Buffer.from(await r.arrayBuffer()));
  }
  const p = normalize(join(here, u.pathname === "/" ? "dashboard.html" : u.pathname));
  if (!p.startsWith(here) || !existsSync(p)) return void res.writeHead(404).end("not found");
  res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" });
  res.end(readFileSync(p));
}).listen(Number(port), () => console.error(`video server on :${port} -> ${target}`));
