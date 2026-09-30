import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 4 * 1024 * 1024) reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Loopback HTTP server shared by every canvas instance. Each instance is
 * isolated by a random token that is only ever handed to the iframe URL.
 */
export function createCanvasServer({ store, onRefresh, onAsk }) {
  const sseClients = new Map();

  function authorize(url) {
    const instanceId = url.searchParams.get("instance");
    const token = url.searchParams.get("token");
    if (!instanceId || !token) return null;
    const instance = store.peek(instanceId);
    if (!instance || instance.token !== token) return null;
    return instanceId;
  }

  function broadcast(instanceId, event, data) {
    const clients = sseClients.get(instanceId);
    if (!clients?.size) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(frame);
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    } catch {
      res.writeHead(400).end("Bad request");
      return;
    }

    if (req.method === "GET" && (url.pathname === "/app.js" || url.pathname === "/styles.css")) {
      const file = path.join(PUBLIC_DIR, path.basename(url.pathname));
      if (!fs.existsSync(file)) {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": STATIC_TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(fs.readFileSync(file));
      return;
    }

    const instanceId = authorize(url);
    if (!instanceId) {
      // The iframe host asks for a favicon without the instance query string;
      // answering 403 there only produces console noise.
      if (req.method === "GET" && url.pathname === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }
      res.writeHead(403).end("Forbidden");
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": STATIC_TYPES[".html"], "Cache-Control": "no-store" });
      res.end(fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8"));
      return;
    }

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(": connected\n\n");
      if (!sseClients.has(instanceId)) sseClients.set(instanceId, new Set());
      sseClients.get(instanceId).add(res);

      const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(keepAlive);
        sseClients.get(instanceId)?.delete(res);
      });

      res.write(`event: state\ndata: ${JSON.stringify(store.snapshot(instanceId))}\n\n`);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      sendJson(res, 200, store.snapshot(instanceId));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/refresh") {
      let body = {};
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return;
      }
      onRefresh(instanceId, body).catch(() => {});
      sendJson(res, 202, { accepted: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/select") {
      let body = {};
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return;
      }
      store.update(instanceId, (state) => {
        state.selectedNodeId = body.nodeId ?? null;
        if (body.profileId) state.selectedProfileId = body.profileId;
      });
      broadcast(instanceId, "selection", { nodeId: body.nodeId ?? null, profileId: body.profileId ?? null });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ask") {
      let body = {};
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const sent = onAsk(instanceId, body);
      sendJson(res, sent ? 200 : 503, { ok: sent });
      return;
    }

    res.writeHead(404).end("Not found");
  });

  return {
    server,
    broadcast,
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      }),
    closeInstance(instanceId) {
      for (const client of sseClients.get(instanceId) ?? []) client.end();
      sseClients.delete(instanceId);
    },
  };
}
