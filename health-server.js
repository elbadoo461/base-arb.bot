/**
 * health-server.js
 * ─────────────────
 * Lightweight HTTP server that satisfies Railway's health-check requirement.
 * Runs as a worker_thread spawned by bot.js so it never blocks the main
 * arbitrage loop.
 *
 * Endpoints
 * ─────────
 *  GET /          → 200 OK  {"status":"ok","service":"base-arb.bot"}
 *  GET /health    → 200 OK  (alias)
 *  GET /ready     → 200 OK  {"status":"ready"}
 *  *              → 404
 *
 * No external dependencies — uses Node.js built-in `http` module only.
 */

"use strict";

const http = require("http");

const PORT    = parseInt(process.env.PORT || "8080", 10);
const SERVICE = "base-arb.bot";

const ROUTES = {
  "/":       () => ({ status: "ok",    service: SERVICE, ts: new Date().toISOString() }),
  "/health": () => ({ status: "ok",    service: SERVICE, ts: new Date().toISOString() }),
  "/ready":  () => ({ status: "ready", service: SERVICE, ts: new Date().toISOString() }),
};

const server = http.createServer((req, res) => {
  const handler = ROUTES[req.url];

  if (handler && req.method === "GET") {
    const body = JSON.stringify(handler());
    res.writeHead(200, {
      "Content-Type"   : "application/json",
      "Content-Length" : Buffer.byteLength(body),
      "Cache-Control"  : "no-store",
    });
    res.end(body);
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

server.on("error", (err) => {
  console.error(`[HEALTH_SERVER] Error: ${err.message}`);
  // If the port is already in use, exit so the worker restarts with a fresh bind
  if (err.code === "EADDRINUSE") process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[HEALTH_SERVER] Listening on 0.0.0.0:${PORT}`);
});

// Keep the worker alive
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
