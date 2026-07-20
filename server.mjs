// OSWALD self-host server — static SPA + packed assets + CORS proxy.
// Replaces Cloudflare Pages/Workers for a private (tailnet) instance.
// Usage: node server.mjs [port]   (default 8090)
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

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

// The app requires a secure context (OPFS build storage, Auth0) — bounce plain-HTTP
// page loads (e.g. http://<tailnet-ip>:8090) to the HTTPS front door. Tailscale-proxied
// requests carry x-forwarded-proto=https and pass through; localhost stays direct.
const HTTPS_URL = process.env.OSWALD_HTTPS_URL ?? "https://xolo.tail5ebed4.ts.net";

// ponytail: one-way desktop→web build sync — open a link, then save in-app (OPFS).
// Write-back to desktop needs an upload endpoint; add only if actually wanted.
const BUILDS_DIR =
  process.env.OSWALD_BUILDS_DIR ?? path.join(process.env.HOME, "PathOfBuildingCommunity-PoE2-Portable/Builds");

function buildsPage(res) {
  const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const items = readdirSync(BUILDS_DIR, { recursive: true })
    .filter(f => f.endsWith(".xml"))
    .map(f => ({ f, mtime: statSync(path.join(BUILDS_DIR, f)).mtime }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ f, mtime }) => {
      const code = deflateSync(readFileSync(path.join(BUILDS_DIR, f)))
        .toString("base64")
        .replaceAll("+", "-")
        .replaceAll("/", "_");
      const name = esc(f.replace(/\.xml$/, ""));
      return `<li><a href="/poe2#build=${code}">${name}</a> <small>${mtime.toISOString().slice(0, 10)}</small></li>`;
    });
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OSWALD — Desktop Builds</title>
<body style="font-family:sans-serif;background:#121212;color:#eee;padding:1rem">
<h1>Desktop Builds</h1><p>PoB2 desktop บน Xolo — เปิดลิงก์แล้วกด Save ในแอปเพื่อเก็บลงเครื่องนี้</p>
<!-- real HTML input = native iOS paste menu works (canvas text boxes have none) -->
<form id="imp" style="margin:1rem 0"><input name="code" placeholder="วาง build code (poe2.ninja / PoB export)"
 style="width:min(24rem,70%);padding:.5rem;background:#222;color:#eee;border:1px solid #555">
<button style="padding:.5rem 1rem">Open</button></form>
<script>imp.onsubmit=e=>{e.preventDefault();const c=imp.code.value.replace(/\\s+/g,"").replace(/\\+/g,"-").replace(/\\//g,"_");if(c)location="/poe2#build="+c}</script>
<ul style="line-height:2">${items.join("")}</ul>`;
  send(res, 200, html, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  const host = (req.headers.host ?? "").split(":")[0];
  if (
    HTTPS_URL &&
    req.headers["x-forwarded-proto"] !== "https" &&
    host !== "localhost" &&
    host !== "127.0.0.1" &&
    (req.headers.accept ?? "").includes("text/html")
  ) {
    return send(res, 302, "redirecting to secure origin", { Location: HTTPS_URL + req.url });
  }

  if (p === "/builds") {
    try {
      return buildsPage(res);
    } catch (e) {
      return send(res, 500, `builds listing failed: ${e.message}`);
    }
  }

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
