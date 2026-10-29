"use strict";
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOST = "127.0.0.1";
const PORT = Number(process.env.ACCIO_RELAY_PORT || 18767);
const ORIGINAL_GATEWAY = (process.env.ACCIO_ORIGINAL_GATEWAY_URL || "https://phoenix-gw.alibaba.com").replace(/\/+$/, "");
const MODEL_BRIDGE = process.env.ACCIO_MODEL_BRIDGE_URL || "http://127.0.0.1:18765";
const LOCAL_GATEWAY = process.env.ACCIO_LOCAL_GATEWAY_URL || "http://127.0.0.1:4097";
const LOCAL_GATEWAY_USERNAME = "phoenix";
const LOCAL_GATEWAY_PASSWORD = process.env.ACCIO_LOCAL_GATEWAY_PASSWORD || "";
const LOCAL_GATEWAY_AUTH = LOCAL_GATEWAY_PASSWORD
  ? `Basic ${Buffer.from(`${LOCAL_GATEWAY_USERNAME}:${LOCAL_GATEWAY_PASSWORD}`).toString("base64")}`
  : "";
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const LOG_PATH = process.env.ACCIO_RELAY_LOG || "";
const MODEL_CACHE_PATH = process.env.ACCIO_MODEL_CACHE_PATH || path.join(os.homedir(), ".accio", "model_cache.json");
const MODEL_LABEL_SEPARATOR = " | Accio: ";
const MODEL_CATALOG_TTL_SECONDS = 5;
const ROUTE_MODE = (process.env.ACCIO_ROUTE_MODE || "custom").trim();
const DEFAULT_MODEL_PATHS = [
  "/api/adk/llm/generateContent",
  "/api/adk/llm/streamGenerateContent",
];
const DEFAULT_IMAGE_PATHS = [
  "/api/image/generate",
  "/api/image/edit",
  "/api/media/image/generate",
  "/api/media/image/edit",
];
const MODEL_PATHS = parsePathList(process.env.ACCIO_MODEL_PATHS, DEFAULT_MODEL_PATHS);
const IMAGE_PATHS = parsePathList(process.env.ACCIO_IMAGE_PATHS, DEFAULT_IMAGE_PATHS);

function parsePathList(value, fallback) {
  const items = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function logRoute(message) {
  if (!LOG_PATH) return;
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {}
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function getHeader(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function isLocalRuntimeRequest(pathname) {
  return (
    pathname === "/skills/catalog" ||
    pathname === "/skills/installed" ||
    pathname === "/skills/picker-catalog" ||
    pathname.startsWith("/skills/") ||
    pathname === "/mcp-servers" ||
    pathname.startsWith("/mcp-servers/") ||
    pathname === "/mcp" ||
    pathname.startsWith("/mcp/") ||
    pathname === "/plugins/installed" ||
    pathname.startsWith("/plugins/") ||
    pathname === "/connectors" ||
    pathname.startsWith("/connectors/")
  );
}

function isModelPath(pathname) {
  if (MODEL_PATHS.includes(pathname)) return true;
  if (pathname === "/api/adk/llm" || pathname.startsWith("/api/adk/llm/")) {
    return /generateContent|streamGenerateContent/i.test(pathname);
  }
  return false;
}

function isImagePath(pathname) {
  return IMAGE_PATHS.includes(pathname);
}

function stripActualModelLabel(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const separatorIndex = text.indexOf(MODEL_LABEL_SEPARATOR);
  return separatorIndex === -1 ? text : text.slice(separatorIndex + MODEL_LABEL_SEPARATOR.length).trim();
}

function providerDisplayName(provider) {
  if (provider === "opencode_go") return "OpenCode Go";
  if (provider === "custom_openai") return "自定义 API";
  return typeof provider === "string" ? provider.trim() : "";
}

async function getActualModelStatus() {
  const health = await fetch(`${MODEL_BRIDGE}/healthz`);
  if (!health.ok) throw new Error(`model bridge health check failed: ${health.status}`);
  const status = await health.json();
  if (status.ok !== true || typeof status.model !== "string" || !status.model.trim()) {
    throw new Error("model bridge did not report an active model");
  }
  return status;
}

function applyActualModelLabel(snapshot, status) {
  if (!Array.isArray(snapshot.data) || !snapshot.ext || !Array.isArray(snapshot.ext.labelList)) {
    throw new Error("invalid Accio model catalog snapshot");
  }
  const model =
    typeof status.resolvedModel === "string" && status.resolvedModel.trim()
      ? status.resolvedModel.trim()
      : status.model.trim();
  const provider = providerDisplayName(status.provider);
  const reasoningEffort = typeof status.reasoningEffort === "string" ? status.reasoningEffort.trim() : "";
  const protocol = typeof status.protocol === "string" ? status.protocol.trim() : "";
  const modelLabel = provider ? `${provider} · ${model}` : model;
  const withEffort = reasoningEffort ? `${modelLabel} · ${reasoningEffort}` : modelLabel;
  const actualLabel = protocol && protocol !== "chat_completions" ? `${withEffort} · ${protocol}` : withEffort;
  const decoratedModelCodes = new Set();
  for (const itemProvider of snapshot.data) {
    if (!Array.isArray(itemProvider.modelList)) continue;
    for (const item of itemProvider.modelList) {
      if (item.visible === false || typeof item.modelCode !== "string" || !item.modelCode.trim()) continue;
      const originalLabel = stripActualModelLabel(item.modelDisplayName) || item.modelCode.trim();
      item.modelDisplayName = `${actualLabel}${MODEL_LABEL_SEPARATOR}${originalLabel}`;
      decoratedModelCodes.add(item.modelCode);
    }
  }
  for (const label of snapshot.ext.labelList) {
    if (!decoratedModelCodes.has(label.targetModelCode)) continue;
    const originalLabel = stripActualModelLabel(label.displayName) || label.targetModelCode;
    label.displayName = `${actualLabel}${MODEL_LABEL_SEPARATOR}${originalLabel}`;
  }
  const baseVersion = String(snapshot.ext.version).split("-actual-")[0];
  snapshot.ext.version = `${baseVersion}-actual-${Buffer.from(actualLabel).toString("base64url")}`;
  snapshot.ext.serverTime = Date.now();
  snapshot.ext.nextChangeAt = null;
  snapshot.ext.ttlSeconds = MODEL_CATALOG_TTL_SECONDS;
  return { snapshot, actualLabel };
}

// v3（Accio 0.36 起）：routeSnapshots 的键是 [网关, 账号, 地区, 语言, 版本, 标志] 的 JSON 数组，
// 值是 { raw, etag, validatedAt }；旧的「地区::语言」快照移到了 legacySnapshots。
function pickRouteSnapshot(routeSnapshots, region, language) {
  const entries = [];
  for (const [key, value] of Object.entries(routeSnapshots)) {
    if (!value || typeof value.raw !== "object" || value.raw === null) continue;
    let parts = [];
    try { parts = JSON.parse(key); } catch {}
    if (!Array.isArray(parts)) parts = [];
    entries.push({
      raw: value.raw,
      official: parts[0] === ORIGINAL_GATEWAY,
      matches: String(parts[2] || "").toUpperCase() === region && String(parts[3] || "").toLowerCase() === language,
      validatedAt: Number(value.validatedAt) || 0,
    });
  }
  // 优先同地区语言、来自官方网关（标签未被改写）、最近校验过的快照
  entries.sort((a, b) => b.matches - a.matches || b.official - a.official || b.validatedAt - a.validatedAt);
  return entries[0]?.raw;
}

function readCachedModelCatalog(request) {
  const cache = JSON.parse(fs.readFileSync(MODEL_CACHE_PATH, "utf8"));
  const region = getHeader(request, "x-package-region").trim().toUpperCase();
  const language = getHeader(request, "accept-language").split(",")[0].trim().replace("_", "-").split("-")[0].toLowerCase();
  const cacheKey = `${region}::${language}`;
  let snapshot;
  if (cache.version === 3 && cache.routeSnapshots && typeof cache.routeSnapshots === "object") {
    const legacy = cache.legacySnapshots && typeof cache.legacySnapshots === "object" ? cache.legacySnapshots : {};
    snapshot = pickRouteSnapshot(cache.routeSnapshots, region, language) || legacy[cacheKey] || legacy["GLOBAL::zh"] || Object.values(legacy)[0];
  } else if (cache.version === 2 && cache.snapshots && typeof cache.snapshots === "object") {
    snapshot = cache.snapshots[cacheKey] || cache.snapshots["GLOBAL::zh"] || Object.values(cache.snapshots)[0];
  } else {
    throw new Error("unsupported Accio model cache format");
  }
  if (!snapshot) throw new Error(`Accio model cache snapshot not found: ${cacheKey}`);
  return JSON.parse(JSON.stringify(snapshot));
}

async function serveModelCatalog(request, response) {
  const snapshot = readCachedModelCatalog(request);
  const status = await getActualModelStatus();
  const catalog = applyActualModelLabel(snapshot, status);
  logRoute(`catalog 200 actualModel=${catalog.actualLabel}`);
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(catalog.snapshot));
}

async function forward(request, response, baseUrl, bodyOverride) {
  const incomingUrl = new URL(request.url || "/", `http://${HOST}:${PORT}`);
  const targetUrl = `${baseUrl}${incomingUrl.pathname}${incomingUrl.search}`;
  logRoute(`forward ${request.method} ${incomingUrl.pathname} -> ${baseUrl}`);
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (["accept-encoding", "connection", "content-length", "host", "transfer-encoding"].includes(name)) continue;
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (baseUrl === LOCAL_GATEWAY && LOCAL_GATEWAY_AUTH) headers.authorization = LOCAL_GATEWAY_AUTH;
  const body = ["GET", "HEAD"].includes(request.method || "GET") ? undefined : bodyOverride ?? (await readBody(request));
  let upstream;
  try {
    upstream = await fetch(targetUrl, { method: request.method, headers, body });
  } catch (error) {
    logRoute(`error ${request.method} ${incomingUrl.pathname} -> ${baseUrl} ${error?.message || String(error)}`);
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "ACCIO_GATEWAY_NETWORK", message: error?.message || String(error) }));
    return;
  }
  logRoute(`response ${request.method} ${incomingUrl.pathname} <- ${upstream.status}`);
  const responseHeaders = {};
  for (const [name, value] of upstream.headers) {
    if (["connection", "content-encoding", "content-length", "transfer-encoding"].includes(name)) continue;
    responseHeaders[name] = value;
  }
  response.writeHead(upstream.status, responseHeaders);
  if (upstream.body) {
    for await (const chunk of upstream.body) response.write(chunk);
  }
  response.end();
}

// 最近一次收到 Accio 请求的时间，供桌面端判断 Accio 是否已接入
let lastClientRequestAt = 0;

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          routeMode: ROUTE_MODE,
          modelBridge: MODEL_BRIDGE,
          originalGateway: ORIGINAL_GATEWAY,
          modelPaths: MODEL_PATHS,
          imagePaths: IMAGE_PATHS,
          lastClientRequestAt,
        }),
      );
      return;
    }
    lastClientRequestAt = Date.now();
    const pathname = new URL(request.url || "/", `http://${HOST}:${PORT}`).pathname;
    if (request.method === "POST" && pathname === "/api/llm/config/v2") {
      if (ROUTE_MODE === "official") {
        await forward(request, response, ORIGINAL_GATEWAY);
        return;
      }
      const catalogBody = await readBody(request);
      try {
        await serveModelCatalog(request, response);
      } catch (error) {
        logRoute(`catalog fallback ${error?.message || String(error)}`);
        await forward(request, response, ORIGINAL_GATEWAY, catalogBody);
      }
      return;
    }
    const modelRequest = request.method === "POST" && isModelPath(pathname);
    const imageHttpRequest = request.method === "POST" && isImagePath(pathname);
    if (ROUTE_MODE === "official") {
      await forward(request, response, isLocalRuntimeRequest(pathname) ? LOCAL_GATEWAY : ORIGINAL_GATEWAY);
      return;
    }
    if (modelRequest || imageHttpRequest) {
      logRoute(`model ${request.method} ${pathname} -> ${MODEL_BRIDGE}`);
      await forward(request, response, MODEL_BRIDGE);
      return;
    }
    const target = isLocalRuntimeRequest(pathname) ? LOCAL_GATEWAY : ORIGINAL_GATEWAY;
    await forward(request, response, target);
  } catch (error) {
    if (!response.writableEnded) {
      if (response.headersSent) { response.destroy(error); return; }
      response.writeHead(502, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "ACCIO_RELAY", message: error?.message || String(error) }));
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Accio gateway relay listening on http://${HOST}:${server.address().port} mode=${ROUTE_MODE}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
