// OSWALD self-host server — static SPA + packed assets + CORS proxy.
// Replaces Cloudflare Pages/Workers for a private (tailnet) instance.
// Usage: node server.mjs [port]   (default 8090)
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(root, "packages/web/build/client");
const PACK_DIR = path.join(root, "packages/packer/r2");
const VERSION_JSON = path.join(root, "version.json");
const PORT = Number(process.argv[2] ?? 8090);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".zip": "application/zip",
  ".txt": "text/plain; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendFile(res, file, cacheable) {
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": statSync(file).size,
    // ponytail: versioned asset paths never change → long cache; everything else no-cache
    "Cache-Control": cacheable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(file).pipe(res);
}

// Mirrors packages/web/functions/api/fetch.ts (Cloudflare worker CORS proxy).
async function apiFetch(req, res) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    const { url, headers, body } = JSON.parse(raw);
    const r = await fetch(url, { method: body ? "POST" : "GET", headers, body });
    send(res, 200, JSON.stringify({ body: await r.text(), headers: Object.fromEntries(r.headers.entries()), status: r.status }), {
      "Content-Type": "application/json",
    });
  } catch (e) {
    send(res, 200, JSON.stringify({ body: undefined, headers: {}, error: e.message }), { "Content-Type": "application/json" });
  }
}

function resolveSafe(base, urlPath) {
  const file = path.normalize(path.join(base, decodeURIComponent(urlPath)));
  return file.startsWith(base) ? file : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (p === "/api/fetch" && req.method === "POST") return apiFetch(req, res);
  if (p.startsWith("/api/")) return send(res, 404, "not found"); // kv/cloud save not supported

  if (p === "/pack/version.json") return sendFile(res, VERSION_JSON, false);
  if (p.startsWith("/pack/")) {
    const file = resolveSafe(PACK_DIR, p.slice("/pack".length));
    if (file && existsSync(file) && statSync(file).isFile()) return sendFile(res, file, true);
    return send(res, 404, "not found");
  }

  const file = resolveSafe(CLIENT_DIR, p === "/" ? "/index.html" : p);
  if (file && existsSync(file) && statSync(file).isFile()) {
    return sendFile(res, file, p.startsWith("/assets/"));
  }
  return sendFile(res, path.join(CLIENT_DIR, "index.html"), false); // SPA fallback
});

server.listen(PORT, () => console.log(`OSWALD serving on http://0.0.0.0:${PORT}`));
