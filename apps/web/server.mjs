import http from "node:http";
import https from "node:https";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { resolve, extname, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import handler from "./dist/server/server.js";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const upstream = new URL(process.env.PC_API_URL || "http://127.0.0.1:4311");
const origin = process.env.PC_WEB_ORIGIN || `http://${host}:${port}`;
const clientRoot = resolve(import.meta.dirname, "dist/client");
const transport = upstream.protocol === "https:" ? https : http;
const mime = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
const isApi = (path) =>
  path === "/api" ||
  path.startsWith("/api/") ||
  path.split("?")[0] === "/install.sh";
const proxyHeaders = (headers) => {
  const copy = { ...headers, host: upstream.host };
  delete copy["proxy-authorization"];
  delete copy["proxy-connection"];
  return copy;
};
const server = http.createServer(async (req, res) => {
  const path = req.url || "/";
  if (!path.startsWith("/") || path.startsWith("//")) {
    res.writeHead(400);
    res.end("Invalid request target");
    return;
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  if (isApi(path)) {
    res.setHeader("Cache-Control", "no-store");
    const proxy = transport.request(
      new URL(path, upstream),
      { method: req.method, headers: proxyHeaders(req.headers) },
      (response) => {
        res.writeHead(response.statusCode || 502, response.headers);
        response.pipe(res);
      },
    );
    proxy.on("error", () => {
      if (!res.headersSent)
        res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Control plane unavailable" }));
    });
    req.on("aborted", () => proxy.destroy());
    req.pipe(proxy);
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(path, origin).pathname);
    const file = resolve(clientRoot, `.${pathname}`);
    if (file.startsWith(clientRoot + sep)) {
      const info = await stat(file).catch(() => null);
      if (info?.isFile()) {
        if (!["GET", "HEAD"].includes(req.method || "GET")) {
          res.writeHead(405);
          res.end();
          return;
        }
        res.setHeader(
          "Content-Type",
          mime[extname(file)] || "application/octet-stream",
        );
        res.setHeader(
          "Cache-Control",
          pathname.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        );
        res.setHeader("Content-Length", info.size);
        if (req.method === "HEAD") res.end();
        else await pipeline(createReadStream(file), res);
        return;
      }
    }
    const abort = new AbortController();
    req.on("aborted", () => abort.abort());
    const request = new Request(new URL(path, origin), {
      method: req.method,
      headers: req.headers,
      signal: abort.signal,
      ...(!["GET", "HEAD"].includes(req.method || "GET")
        ? { body: Readable.toWeb(req), duplex: "half" }
        : {}),
    });
    const response = await handler.fetch(request);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      if (key !== "set-cookie") res.setHeader(key, value);
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader("set-cookie", cookies);
    if (response.body && req.method !== "HEAD")
      await pipeline(Readable.fromWeb(response.body), res);
    else res.end();
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Unable to render the dashboard.");
    console.error("Web request failed:", error.message);
  }
});
server.on("upgrade", (req, socket, head) => {
  if (
    !/^\/api\/(?:events|services\/[a-zA-Z0-9-]+\/events)(?:\?|$)/.test(
      req.url || "",
    )
  ) {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }
  const proxy = transport.request(new URL(req.url, upstream), {
    headers: proxyHeaders(req.headers),
  });
  proxy.on("upgrade", (response, upstreamSocket, upstreamHead) => {
    socket.write(
      `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` +
        Object.entries(response.headers)
          .flatMap(([key, value]) =>
            Array.isArray(value)
              ? value.map((v) => `${key}: ${v}\r\n`)
              : [`${key}: ${value}\r\n`],
          )
          .join("") +
        "\r\n",
    );
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    socket.on("error", () => upstreamSocket.destroy());
    upstreamSocket.on("error", () => socket.destroy());
    socket.on("close", () => upstreamSocket.destroy());
    socket.pipe(upstreamSocket).pipe(socket);
  });
  proxy.on("response", (response) => {
    socket.end(
      `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`,
    );
    response.resume();
  });
  proxy.on("error", () => socket.destroy());
  proxy.end();
});
server.listen(port, host, () =>
  console.log(`Personal Cloud web listening on ${host}:${port}`),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  });
