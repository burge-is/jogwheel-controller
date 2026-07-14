"use strict";

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);
const allowedExtensions = new Set([".html", ".js"]);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

function resolveRequest(rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(String(rawUrl || "/").split("?", 1)[0]);
  } catch {
    return { error: 400 };
  }

  if (pathname === "/" || pathname === "/examples/dual-dj") {
    return { redirect: "/examples/dual-dj/" };
  }
  if (pathname === "/examples/dual-dj/") pathname += "index.html";
  if (pathname.includes("\0") || pathname.split("/").some(part => part.startsWith("."))) {
    return { error: 403 };
  }

  const allowedPrefix = pathname.startsWith("/src/") || pathname.startsWith("/examples/dual-dj/");
  if (!allowedPrefix || !allowedExtensions.has(path.extname(pathname).toLowerCase())) {
    return { error: 403 };
  }

  const resolved = path.resolve(root, `.${pathname}`);
  if (!resolved.startsWith(`${root}${path.sep}`)) return { error: 403 };
  return { filePath: resolved };
}

function headers(contentType = "text/plain; charset=utf-8") {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Origin-Agent-Cluster": "?1"
  };
}

const server = http.createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { ...headers(), Allow: "GET, HEAD" });
    response.end("Method not allowed");
    return;
  }

  const target = resolveRequest(request.url);
  if (target.redirect) {
    response.writeHead(302, { Location: target.redirect, ...headers() });
    response.end();
    return;
  }
  if (target.error) {
    response.writeHead(target.error, headers());
    response.end(target.error === 400 ? "Bad request" : "Forbidden");
    return;
  }

  fs.stat(target.filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      response.writeHead(404, headers());
      response.end("Not found");
      return;
    }

    response.writeHead(200, headers(contentTypes[path.extname(target.filePath)]));
    if (request.method === "HEAD") response.end();
    else fs.createReadStream(target.filePath).pipe(response);
  });
});

server.on("error", error => {
  console.error(`Could not start the example server: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`JogWheel dual DJ example: http://${host}:${port}/`);
  console.log("No uploads and no request logging. Ctrl+C stops it.");
});
