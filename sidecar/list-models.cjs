"use strict";
// 用供应商的 API Key 读取可用模型：GET {接口基础地址}/models，结果以 JSON 打印到标准输出。
// Key 通过环境变量传入，不出现在命令行参数里。
const ENDPOINT = process.env.LIST_MODELS_ENDPOINT || "";
const API_KEY = process.env.LIST_MODELS_API_KEY || "";
const TIMEOUT_MS = 15000;

function modelsUrl(endpoint) {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("接口地址必须以 http:// 或 https:// 开头");
  url.pathname = url.pathname.replace(/\/(chat\/completions|responses)\/?$/, "").replace(/\/+$/, "") + "/models";
  url.search = "";
  url.hash = "";
  return url.toString();
}

// 兼容 OpenAI 的 { data: [{ id }] }，以及部分服务的 { models: [...] }
function parseModels(body) {
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  const models = [];
  for (const item of list) {
    const id = typeof item === "string" ? item : item?.id ?? item?.name ?? item?.model;
    if (typeof id !== "string" || !id.trim()) continue;
    const endpoints = Array.isArray(item?.supported_endpoint_types) ? item.supported_endpoint_types.map(String) : undefined;
    models.push({ id: id.trim().replace(/^models\//, ""), ...(endpoints ? { endpoints } : {}) });
  }
  return models;
}

async function main() {
  const url = modelsUrl(ENDPOINT);
  const response = await fetch(url, {
    headers: { Accept: "application/json", ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 300);
    try { message = JSON.parse(text)?.error?.message || JSON.parse(text)?.message || message; } catch {}
    throw new Error(`HTTP ${response.status} ${message}`.trim());
  }
  const models = parseModels(JSON.parse(text));
  if (models.length === 0) throw new Error("接口没有返回模型");
  return models;
}

main()
  .then((models) => process.stdout.write(JSON.stringify({ ok: true, models })))
  .catch((error) => process.stdout.write(JSON.stringify({ ok: false, error: error?.message || String(error) })));
