// Minimal local dev server: serves public/ and mounts the api/ handlers with a
// small (req,res) adapter shim matching the Vercel Node runtime surface.
// Production runs on Vercel; this exists for local testing and CI smoke runs.
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath, parse as parseUrl } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 3000);

const routes = {};
for (const f of fs.readdirSync(path.join(ROOT, "api"))) {
  if (!f.endsWith(".js")) continue;
  const name = f.replace(/\.js$/, "");
  routes["/api/" + name] = (await import(path.join(ROOT, "api", f))).default;
}

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".md": "text/markdown" };

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const route = routes[u.pathname];
  if (route) {
    req.query = Object.fromEntries(u.searchParams);
    if (req.method === "POST") {
      req.body = await new Promise((resolve) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => resolve(b));
      });
    }
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
    res.send = (body) => res.end(body);
    try { await route(req, res); } catch (e) { res.statusCode = 500; res.end(String(e.stack || e)); }
    return;
  }
  // static
  let p = u.pathname === "/" ? "/index.html" : u.pathname;
  const file = path.join(ROOT, "public", path.normalize(p).replace(/^([.][.][/\\])+/, ""));
  if (file.startsWith(path.join(ROOT, "public")) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
    res.end(fs.readFileSync(file));
  } else {
    res.statusCode = 404;
    res.end("not found");
  }
}).listen(PORT, () => console.log(`fairline dev server on http://localhost:${PORT}`));
