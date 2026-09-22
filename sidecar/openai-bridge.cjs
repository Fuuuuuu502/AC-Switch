const http = require("node:http");
const { gunzip } = require("node:zlib");
const { promisify } = require("node:util");
const { reasoningOptions } = require("./reasoning-options.cjs");
const gunzipAsync = promisify(gunzip);

const HOST = "127.0.0.1";
const PORT = Number(process.env.ACCIO_OPENCODE_PORT || 18765);
const MODEL = process.env.OPENCODE_GO_MODEL || "deepseek-v4-flash";
const ENDPOINT = process.env.OPENCODE_GO_ENDPOINT || "https://opencode.ai/zen/go/v1/chat/completions";
const AUTH_TYPE = process.env.ACCIO_MODEL_AUTH_TYPE || "api_key";
const API_PROVIDER = process.env.ACCIO_API_PROVIDER || "opencode_go";
const API_PROTOCOL = (process.env.ACCIO_API_PROTOCOL || "chat_completions").trim().toLowerCase();
const REASONING_MODE = process.env.OPENCODE_GO_REASONING_EFFORT || (API_PROVIDER === "volcengine_coding_plan" ? "default" : "high");
const ORIGINAL_GATEWAY = (process.env.ACCIO_ORIGINAL_GATEWAY_URL || "https://phoenix-gw.alibaba.com").replace(/\/+$/, "");
const IMAGE_ENABLED = process.env.ACCIO_IMAGE_ENABLED === "true";
const IMAGE_ENDPOINT = (process.env.OPENCODE_GO_IMAGE_ENDPOINT || "").trim();
const IMAGE_MODEL = (process.env.OPENCODE_GO_IMAGE_MODEL || "").trim();
const IMAGE_API_KEY = (process.env.OPENCODE_GO_IMAGE_API_KEY || "").trim();
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const reasoningByToolCallId = new Map();
let resolvedModel = MODEL;

const volcengineReasoningModesByModel = new Map([
  ["deepseek-v4-flash", ["default", "disabled", "enabled", "low", "high", "max"]],
  ["deepseek-v4-pro", ["default", "disabled", "enabled", "high", "max"]],
  ["doubao-seed-2.0-lite", ["default", "disabled", "enabled", "low", "medium", "high"]],
  ["glm-5.3", ["default", "low", "high", "max"]],
  ["glm-5.2", ["default", "high", "max"]],
  ["minimax-m3", ["default", "disabled", "enabled"]],
]);

if (!["opencode_go", "volcengine_coding_plan", "custom_openai"].includes(API_PROVIDER)) {
  throw new Error(`Unsupported API provider: ${API_PROVIDER}`);
}
const supportedReasoningModes = API_PROVIDER === "volcengine_coding_plan"
  ? volcengineReasoningModesByModel.get(MODEL.toLowerCase()) || ["default"]
  : API_PROVIDER === "custom_openai"
    ? ["disabled", "low", "medium", "high", "xhigh", "max"]
    : ["disabled", "low", "high", "max"];
if (!supportedReasoningModes.includes(REASONING_MODE)) {
  throw new Error(`Unsupported reasoning mode: ${REASONING_MODE}`);
}

function valueOf(object, camel, snake) {
  return object?.[camel] ?? object?.[snake];
}

function parseJson(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function textFromParts(parts) {
  return (Array.isArray(parts) ? parts : [])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

function contentFromParts(parts) {
  const values = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (typeof part?.text === "string") {
      values.push({ type: "text", text: part.text });
      continue;
    }
    const inlineData = part?.inlineData ?? part?.inline_data;
    if (inlineData?.data) {
      const mimeType = inlineData.mimeType ?? inlineData.mime_type ?? "application/octet-stream";
      values.push({ type: "image_url", image_url: { url: `data:${mimeType};base64,${inlineData.data}` } });
      continue;
    }
    const fileData = part?.fileData ?? part?.file_data;
    if (fileData?.fileUri ?? fileData?.file_uri) {
      values.push({ type: "image_url", image_url: { url: fileData.fileUri ?? fileData.file_uri } });
    }
  }
  if (values.length === 0) return null;
  if (values.every((value) => value.type === "text")) return values.map((value) => value.text).join("");
  return values;
}

function functionCallFromPart(part) {
  const call = part?.functionCall ?? part?.function_call;
  if (!call) return null;
  const args = call.argsJson ?? call.args_json ?? call.arguments ?? call.args;
  return {
    id: call.id || `call_${Math.random().toString(36).slice(2)}`,
    type: "function",
    function: {
      name: call.name || "",
      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
    },
  };
}

function functionResponseFromPart(part) {
  const response = part?.functionResponse ?? part?.function_response;
  if (!response) return null;
  const value = response.responseJson ?? response.response_json ?? response.response;
  return {
    role: "tool",
    tool_call_id: response.id || response.name || "",
    content: typeof value === "string" ? value : JSON.stringify(value ?? {}),
  };
}

function messagesFromContents(contents) {
  const messages = [];
  for (const content of Array.isArray(contents) ? contents : []) {
    const role = content?.role === "model" ? "assistant" : content?.role === "function" ? "tool" : content?.role || "user";
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const toolResponses = parts.map(functionResponseFromPart).filter(Boolean);
    if (toolResponses.length > 0) {
      messages.push(...toolResponses);
      continue;
    }
    const toolCalls = parts.map(functionCallFromPart).filter(Boolean);
    const text = contentFromParts(parts);
    if (toolCalls.length > 0 || text !== null) {
      const reasoningContent = toolCalls
        .map((call) => reasoningByToolCallId.get(call.id))
        .find((value) => typeof value === "string" && value.length > 0);
      messages.push({
        role,
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      });
    }
  }
  return messages;
}

function systemMessage(instruction) {
  if (!instruction) return null;
  if (typeof instruction === "string") return { role: "system", content: instruction };
  if (Array.isArray(instruction?.parts)) {
    const content = textFromParts(instruction.parts);
    return content ? { role: "system", content } : null;
  }
  return null;
}

function normalizeToolDeclaration(declaration) {
  const functionDeclaration = declaration?.function ?? declaration?.functionDeclaration ?? declaration?.function_declaration ?? declaration;
  const parameters = parseJson(
    functionDeclaration?.parameters ?? functionDeclaration?.parametersJson ?? functionDeclaration?.parameters_json,
    { type: "object", properties: {} },
  );
  if (!functionDeclaration?.name) return null;
  return {
    type: "function",
    function: {
      name: functionDeclaration.name,
      description: functionDeclaration.description || "",
      parameters,
    },
  };
}

function openAiTools(tools) {
  const normalized = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    const declarations = tool?.functionDeclarations ?? tool?.function_declarations;
    if (Array.isArray(declarations)) {
      for (const declaration of declarations) {
        const item = normalizeToolDeclaration(declaration);
        if (item) normalized.push(item);
      }
      continue;
    }
    const item = normalizeToolDeclaration(tool);
    if (item) normalized.push(item);
  }
  return normalized;
}

function openAiToolChoice(choice) {
  if (choice === undefined || choice === null || choice === "") return undefined;
  if (typeof choice === "string") {
    const normalized = choice.toLowerCase();
    if (normalized === "auto") return "auto";
    if (normalized === "none") return "none";
    if (normalized === "any" || normalized === "required") return "auto";
  }
  const functionChoice = choice?.functionCall ?? choice?.function_call ?? choice?.function;
  if (functionChoice?.name) return { type: "function", function: { name: functionChoice.name } };
  return undefined;
}

function toOpenAiRequest(payload) {
  const contents = valueOf(payload, "contents", "contents") || [];
  const instruction = valueOf(payload, "systemInstruction", "system_instruction");
  const tools = openAiTools(valueOf(payload, "tools", "tools"));
  const request = {
    model: MODEL,
    messages: [systemMessage(instruction), ...messagesFromContents(contents)].filter(Boolean),
    stream: true,
    stream_options: { include_usage: true },
  };
  const temperature = valueOf(payload, "temperature", "temperature");
  const maxTokens = valueOf(payload, "maxOutputTokens", "max_output_tokens");
  const topP = valueOf(payload, "topP", "top_p");
  const stop = valueOf(payload, "stopSequences", "stop_sequences");
  if (temperature !== undefined) request.temperature = temperature;
  if (maxTokens !== undefined) request.max_tokens = maxTokens;
  if (topP !== undefined) request.top_p = topP;
  if (Array.isArray(stop) && stop.length > 0) request.stop = stop;
  if (API_PROVIDER === "volcengine_coding_plan") {
    if (["enabled", "disabled"].includes(REASONING_MODE)) {
      request.thinking = { type: REASONING_MODE };
    } else if (REASONING_MODE !== "default") {
      request.thinking = { type: "enabled" };
      request.reasoning_effort = REASONING_MODE;
    }
  } else {
    Object.assign(request, reasoningOptions(ENDPOINT, MODEL, REASONING_MODE));
  }
  if (tools.length > 0) {
    request.tools = tools;
    const toolChoice = openAiToolChoice(valueOf(payload, "toolChoice", "tool_choice"));
    if (toolChoice !== undefined) request.tool_choice = toolChoice;
  }
  const responseFormat = valueOf(payload, "responseFormat", "response_format");
  if (responseFormat) request.response_format = responseFormat;
  return request;
}

async function* sseData(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const events = buffer.split(/\r\n\r\n|\n\n|\r\r/);
    buffer = events.pop() || "";
    for (const event of events) {
      const data = event
        .split(/\r\n|\n|\r/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) yield data;
    }
  }
  const data = buffer
    .split(/\r\n|\n|\r/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (data) yield data;
}

function sendFrame(response, frame) {
  response.write(`data: ${JSON.stringify(frame)}\n\n`);
}

function startKeepalive(response) {
  const timer = setInterval(() => {
    if (response.writableEnded) {
      clearInterval(timer);
      return;
    }
    try {
      response.write(": ping\n\n");
    } catch {
      clearInterval(timer);
    }
  }, 12000);
  return () => clearInterval(timer);
}

function authHeaders(extra = {}) {
  const headers = { "Content-Type": "application/json", ...extra };
  if (AUTH_TYPE === "api_key" && process.env.OPENCODE_GO_API_KEY) {
    headers.Authorization = `Bearer ${process.env.OPENCODE_GO_API_KEY}`;
  }
  return headers;
}

function deriveSiblingEndpoint(endpoint, fromSuffix, toSuffix) {
  const trimmed = String(endpoint || "").replace(/\/+$/, "");
  if (trimmed.endsWith(fromSuffix)) return `${trimmed.slice(0, -fromSuffix.length)}${toSuffix}`;
  if (trimmed.endsWith(toSuffix)) return trimmed;
  return `${trimmed}${toSuffix.startsWith("/") ? toSuffix : `/${toSuffix}`}`;
}

function responsesEndpoint() {
  return deriveSiblingEndpoint(ENDPOINT, "/chat/completions", "/responses");
}

function imageAuthHeaders(extra = {}) {
  const headers = { ...extra };
  const key = IMAGE_API_KEY || process.env.OPENCODE_GO_API_KEY;
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

function imageEndpoint(kind) {
  if (IMAGE_ENDPOINT) {
    if (kind === "edit" && IMAGE_ENDPOINT.includes("/generations")) {
      return IMAGE_ENDPOINT.replace("/generations", "/edits");
    }
    return IMAGE_ENDPOINT;
  }
  return kind === "edit"
    ? "https://api.openai.com/v1/images/edits"
    : "https://api.openai.com/v1/images/generations";
}

function isImagePayload(payload) {
  const generationConfig = payload?.generationConfig ?? payload?.generation_config;
  const responseModalities = generationConfig?.responseModalities ?? generationConfig?.response_modalities;
  if (Array.isArray(responseModalities) && responseModalities.some((item) => String(item).trim().toUpperCase() === "IMAGE")) {
    return true;
  }
  return Boolean(payload?.prompt && (payload?.image || payload?.images || payload?.mask));
}

function lastUserPrompt(payload) {
  if (typeof payload?.prompt === "string" && payload.prompt.trim()) return payload.prompt.trim();
  const contents = valueOf(payload, "contents", "contents") || [];
  for (let index = contents.length - 1; index >= 0; index -= 1) {
    const text = textFromParts(contents[index]?.parts);
    if (text) return text;
  }
  const instruction = systemMessage(valueOf(payload, "systemInstruction", "system_instruction"));
  return instruction?.content || "";
}

function inlineImages(payload) {
  const images = [];
  if (typeof payload?.image === "string") images.push(payload.image);
  if (Array.isArray(payload?.images)) images.push(...payload.images.filter((item) => typeof item === "string"));
  const contents = valueOf(payload, "contents", "contents") || [];
  for (const content of contents) {
    for (const part of Array.isArray(content?.parts) ? content.parts : []) {
      const inlineData = part?.inlineData ?? part?.inline_data;
      if (inlineData?.data) {
        const mime = inlineData.mimeType ?? inlineData.mime_type ?? "image/png";
        images.push(`data:${mime};base64,${inlineData.data}`);
      }
    }
  }
  return images;
}

async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const events = buffer.split(/\r\n\r\n|\n\n|\r\r/);
    buffer = events.pop() || "";
    for (const event of events) {
      let name = "";
      const dataLines = [];
      for (const line of event.split(/\r\n|\n|\r/)) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      const data = dataLines.join("\n");
      if (data) yield { event: name, data };
    }
  }
}

function errorFrame(response, errorCode, errorMessage) {
  sendFrame(response, {
    content: { role: "model", parts: [{ text: "" }] },
    turnComplete: true,
    partial: false,
    errorCode: String(errorCode),
    errorMessage: String(errorMessage),
  });
  response.end();
}

function usageMetadata(usage) {
  if (!usage) return undefined;
  return {
    promptTokenCount: usage.prompt_tokens,
    candidatesTokenCount: usage.completion_tokens,
    totalTokenCount: usage.total_tokens,
  };
}

function requireApiKey(response) {
  const apiKey = process.env.OPENCODE_GO_API_KEY;
  const authorizationAttached = AUTH_TYPE === "api_key" && Boolean(apiKey);
  if (API_PROVIDER === "opencode_go" && !authorizationAttached) {
    errorFrame(
      response,
      "CONFIG",
      "OpenCode Go API Key is not set. Save the key in Accio Switch and enable the provider again.",
    );
    return null;
  }
  if (AUTH_TYPE === "api_key" && !apiKey) {
    errorFrame(response, "CONFIG", "Model API Key is not set");
    return null;
  }
  if (AUTH_TYPE !== "api_key" && AUTH_TYPE !== "none") {
    errorFrame(response, "CONFIG", `Unsupported authentication type: ${AUTH_TYPE}`);
    return null;
  }
  return { apiKey, authorizationAttached };
}

async function handleUpstreamError(response, upstream, authorizationAttached, endpoint) {
  const body = await upstream.text().catch(() => "");
  let message = body.slice(0, 800);
  try {
    const parsed = JSON.parse(body);
    message = parsed?.error?.message || parsed?.error || parsed?.message || message;
    if (typeof message !== "string") message = JSON.stringify(message);
  } catch {}
  console.error(`upstream HTTP ${upstream.status} authorizationAttached=${authorizationAttached} endpoint=${endpoint}`);
  errorFrame(
    response,
    `UPSTREAM_HTTP_${upstream.status}`,
    `${message || upstream.statusText} (authorizationAttached=${authorizationAttached})`,
  );
}

function toResponsesInput(payload) {
  const input = [];
  const instruction = systemMessage(valueOf(payload, "systemInstruction", "system_instruction"));
  if (instruction) input.push({ role: "system", content: instruction.content });
  for (const message of messagesFromContents(valueOf(payload, "contents", "contents") || [])) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? {}),
      });
      continue;
    }
    const content = Array.isArray(message.content) ? message.content.map((part) => {
      if (part.type === "image_url") return { type: "input_image", image_url: part.image_url.url };
      return { type: message.role === "assistant" ? "output_text" : "input_text", text: part.text };
    }) : message.content ?? "";
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      for (const call of message.tool_calls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function?.name || "",
          arguments: call.function?.arguments || "{}",
        });
      }
      if (content) input.push({ role: "assistant", content });
      continue;
    }
    input.push({ role: message.role, content });
  }
  return input;
}

function toResponsesRequest(payload) {
  const tools = openAiTools(valueOf(payload, "tools", "tools")).map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description || "",
    parameters: tool.function.parameters || { type: "object", properties: {} },
  }));
  const request = {
    model: MODEL,
    input: toResponsesInput(payload),
    stream: true,
    store: false,
  };
  if (REASONING_MODE !== "disabled") request.reasoning = { effort: REASONING_MODE };
  if (tools.length > 0) request.tools = tools;
  return request;
}

async function generateImage(prompt, references) {
  const model = IMAGE_MODEL;
  if (!model) throw new Error("image model is not configured");
  const kind = references.length > 0 ? "edit" : "generate";
  const endpoint = imageEndpoint(kind);
  if (kind === "generate") {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { ...imageAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        ...(!model.startsWith("gpt-image-") ? { response_format: "b64_json" } : {}),
      }),
    });
    const body = await upstream.text();
    if (!upstream.ok) throw new Error(body.slice(0, 500) || `image HTTP ${upstream.status}`);
    const parsed = JSON.parse(body);
    const b64 = parsed?.data?.[0]?.b64_json;
    if (!b64) throw new Error("image API did not return b64_json");
    return { b64, mime: "image/png" };
  }
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  if (!model.startsWith("gpt-image-")) form.set("response_format", "b64_json");
  const source = references[0];
  const blob = source.startsWith("data:")
    ? await fetch(source).then((item) => item.blob())
    : new Blob([Buffer.from(source, "base64")], { type: "image/png" });
  form.set("image", blob, "image.png");
  const headers = imageAuthHeaders();
  const upstream = await fetch(endpoint, { method: "POST", headers, body: form });
  const body = await upstream.text();
  if (!upstream.ok) throw new Error(body.slice(0, 500) || `image HTTP ${upstream.status}`);
  const parsed = JSON.parse(body);
  const b64 = parsed?.data?.[0]?.b64_json;
  if (!b64) throw new Error("image edit API did not return b64_json");
  return { b64, mime: "image/png" };
}

async function proxyImage(request, response, payload) {
  if (!IMAGE_ENABLED || !IMAGE_MODEL) {
    errorFrame(
      response,
      "CONFIG",
      "图片通道未启用。当前对话模型不用于生图，请在 Accio Switch 里单独打开图片通道并填写图片模型。",
    );
    return;
  }
  if (!IMAGE_API_KEY && !process.env.OPENCODE_GO_API_KEY) {
    errorFrame(response, "CONFIG", "图片通道没有 API Key");
    return;
  }
  const prompt = lastUserPrompt(payload);
  if (!prompt) {
    errorFrame(response, "CONFIG", "Image request is missing a prompt");
    return;
  }
  const stopKeepalive = startKeepalive(response);
  try {
    const image = await generateImage(prompt, inlineImages(payload));
    sendFrame(response, {
      content: {
        role: "model",
        parts: [
          { text: prompt },
          { inlineData: { mimeType: image.mime, data: image.b64 } },
        ],
      },
      partial: false,
      turnComplete: true,
      finishReason: "STOP",
      customMetadata: { provider: "image_channel", model: IMAGE_MODEL, modality: "image" },
    });
    response.end();
  } catch (error) {
    errorFrame(response, "UPSTREAM_IMAGE", error?.message || String(error));
  } finally {
    stopKeepalive();
  }
}

async function proxyResponses(request, response, payload) {
  const auth = requireApiKey(response);
  if (!auth) return;
  const stopKeepalive = startKeepalive(response);
  const endpoint = responsesEndpoint();
  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: authHeaders({ Accept: "text/event-stream" }),
      body: JSON.stringify(toResponsesRequest(payload)),
      signal: request.signal,
    });
  } catch (error) {
    stopKeepalive();
    errorFrame(response, "UPSTREAM_NETWORK", error?.message || String(error));
    return;
  }
  if (!upstream.ok) {
    stopKeepalive();
    await handleUpstreamError(response, upstream, auth.authorizationAttached, endpoint);
    return;
  }
  const toolCalls = new Map();
  let sawOutput = false;
  let responseId;
  let usage;
  let finishReason;
  let responseModel = MODEL;
  try {
    for await (const { event, data } of sseEvents(upstream.body)) {
      if (data === "[DONE]") continue;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const type = event || chunk.type || "";
      responseId ||= chunk.response?.id || chunk.id;
      if (typeof chunk.response?.model === "string") {
        responseModel = chunk.response.model;
        resolvedModel = responseModel;
      }
      if (chunk.response?.usage) usage = usageMetadata({
        prompt_tokens: chunk.response.usage.input_tokens,
        completion_tokens: chunk.response.usage.output_tokens,
        total_tokens: chunk.response.usage.total_tokens,
      });
      if (type.includes("output_text.delta") && typeof (chunk.delta || chunk.text) === "string") {
        const text = chunk.delta || chunk.text;
        if (text) {
          sawOutput = true;
          sendFrame(response, {
            content: { role: "model", parts: [{ text }] },
            partial: true,
            turnComplete: false,
            customMetadata: { provider: API_PROVIDER, model: responseModel, protocol: "responses", response_id: responseId },
          });
        }
      }
      if ((type.includes("reasoning") || type.includes("thought")) && typeof (chunk.delta || chunk.text) === "string") {
        const text = chunk.delta || chunk.text;
        if (text) {
          sendFrame(response, {
            content: { role: "model", parts: [{ text, thought: true }] },
            partial: true,
            turnComplete: false,
            customMetadata: { provider: API_PROVIDER, model: responseModel, protocol: "responses", response_id: responseId },
          });
        }
      }
      if (type.includes("output_item.added") && chunk.item?.type === "function_call") {
        toolCalls.set(chunk.item.id || chunk.item.call_id || String(toolCalls.size), {
          id: chunk.item.call_id || chunk.item.id || "",
          name: chunk.item.name || "",
          arguments: chunk.item.arguments || "",
        });
      }
      if (type.includes("function_call_arguments.delta") && typeof chunk.delta === "string") {
        const id = chunk.item_id || [...toolCalls.keys()].find((key) => toolCalls.get(key).id === chunk.call_id);
        if (id) {
          const current = toolCalls.get(id) || { id, name: "", arguments: "" };
          current.arguments += chunk.delta;
          toolCalls.set(id, current);
        }
      }
      if (type === "response.function_call_arguments.done") {
        const call = toolCalls.get(chunk.item_id);
        if (call && typeof chunk.arguments === "string") call.arguments = chunk.arguments;
      }
      if (type === "response.output_item.done" && chunk.item?.type === "function_call") {
        toolCalls.set(chunk.item.id || chunk.item.call_id, {
          id: chunk.item.call_id, name: chunk.item.name, arguments: chunk.item.arguments,
        });
      }
      if (type === "error" || type === "response.incomplete") {
        errorFrame(response, "UPSTREAM_RESPONSES", chunk.message || chunk.error?.message || "Responses API 返回不完整结果");
        return;
      }
      if (type.includes("completed") || chunk.response?.status === "completed") finishReason = "STOP";
      if (type.includes("failed") || chunk.response?.status === "failed") {
        errorFrame(response, "UPSTREAM_RESPONSES", chunk.response?.error?.message || "Responses API failed");
        return;
      }
    }
  } finally {
    stopKeepalive();
  }
  if (!finishReason) {
    errorFrame(response, "UPSTREAM_RESPONSES", "Responses 流在完成事件前结束");
    return;
  }
  const parts = [...toolCalls.values()].map((call) => ({
    functionCall: { id: call.id, name: call.name, argsJson: call.arguments || "{}" },
  }));
  if (parts.length > 0) sawOutput = true;
  sendFrame(response, {
    content: parts.length > 0
      ? { role: "model", parts }
      : sawOutput
        ? { role: "model", parts: [] }
        : { role: "model", parts: [{ text: "" }] },
    partial: false,
    turnComplete: true,
    finishReason: finishReason || "STOP",
    usageMetadata: usage,
    customMetadata: { provider: API_PROVIDER, model: responseModel, protocol: "responses", response_id: responseId },
  });
  response.end();
}

async function proxy(request, response, payload) {
  if (isImagePayload(payload)) {
    await proxyImage(request, response, payload);
    return;
  }
  if (API_PROTOCOL === "responses") {
    await proxyResponses(request, response, payload);
    return;
  }
  const auth = requireApiKey(response);
  if (!auth) return;
  const stopKeepalive = startKeepalive(response);
  const upstreamRequest = toOpenAiRequest(payload);
  let upstream;
  try {
    upstream = await fetch(ENDPOINT, {
      method: "POST",
      headers: authHeaders({ Accept: "text/event-stream" }),
      body: JSON.stringify(upstreamRequest),
      signal: request.signal,
    });
  } catch (error) {
    stopKeepalive();
    errorFrame(response, "UPSTREAM_NETWORK", error?.message || String(error));
    return;
  }
  if (!upstream.ok) {
    stopKeepalive();
    await handleUpstreamError(response, upstream, auth.authorizationAttached, ENDPOINT);
    return;
  }
  if (!upstream.body) {
    stopKeepalive();
    errorFrame(response, "UPSTREAM_EMPTY", "Model API returned an empty response body");
    return;
  }

  const toolCalls = new Map();
  let sawOutput = false;
  let responseId;
  let usage;
  let finishReason;
  let reasoningContent = "";
  let responseModel = MODEL;
  try {
  for await (const data of sseData(upstream.body)) {
    if (data === "[DONE]") continue;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    responseId ||= chunk.id;
    if (typeof chunk.model === "string" && chunk.model.trim()) {
      responseModel = chunk.model.trim();
      resolvedModel = responseModel;
    }
    usage ||= usageMetadata(chunk.usage);
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    finishReason ||= choice?.finish_reason;
    if (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      reasoningContent += delta.reasoning_content;
      sendFrame(response, {
        content: { role: "model", parts: [{ text: delta.reasoning_content, thought: true }] },
        partial: true,
        turnComplete: false,
        customMetadata: { provider: API_PROVIDER, model: responseModel, reasoning_effort: REASONING_MODE, response_id: responseId },
      });
    }
    if (typeof delta?.content === "string" && delta.content.length > 0) {
      sawOutput = true;
      sendFrame(response, {
        content: { role: "model", parts: [{ text: delta.content }] },
        partial: true,
        turnComplete: false,
        customMetadata: { provider: API_PROVIDER, model: responseModel, reasoning_effort: REASONING_MODE, response_id: responseId },
      });
    }
    for (const call of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
      const index = call.index ?? toolCalls.size;
      const current = toolCalls.get(index) || { id: "", name: "", arguments: "" };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.name += call.function.name;
      if (call.function?.arguments) current.arguments += call.function.arguments;
      toolCalls.set(index, current);
    }
  }
  } finally {
    stopKeepalive();
  }
  const parts = [...toolCalls.values()].map((call) => ({
    functionCall: {
      id: call.id,
      name: call.name,
      argsJson: call.arguments || "{}",
    },
  }));
  if (parts.length > 0) {
    sawOutput = true;
    if (reasoningContent) {
      for (const call of toolCalls.values()) {
        if (call.id) reasoningByToolCallId.set(call.id, reasoningContent);
      }
      while (reasoningByToolCallId.size > 256) {
        reasoningByToolCallId.delete(reasoningByToolCallId.keys().next().value);
      }
    }
  }
  sendFrame(response, {
    content: parts.length > 0
      ? { role: "model", parts }
      : sawOutput
        ? { role: "model", parts: [] }
        : { role: "model", parts: [{ text: "" }] },
    partial: false,
    turnComplete: true,
    finishReason: finishReason || "STOP",
    usageMetadata: usage,
    customMetadata: { provider: API_PROVIDER, model: responseModel, reasoning_effort: REASONING_MODE, response_id: responseId },
  });
  response.end();
}

async function readJson(request) {
  let body = await readBody(request);
  const encoding = String(request.headers["content-encoding"] || "identity").trim().toLowerCase();
  if (encoding === "gzip") {
    body = await gunzipAsync(body, { maxOutputLength: MAX_BODY_BYTES });
  } else if (encoding !== "identity") {
    throw new Error(`Unsupported Content-Encoding: ${encoding}`);
  }
  return JSON.parse(body.toString("utf8"));
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
    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

async function forwardGateway(request, response) {
  const incomingUrl = new URL(request.url || "/", `http://${HOST}:${PORT}`);
  const targetUrl = `${ORIGINAL_GATEWAY}${incomingUrl.pathname}${incomingUrl.search}`;
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (["accept-encoding", "connection", "content-length", "host", "transfer-encoding"].includes(name)) continue;
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  const body = ["GET", "HEAD"].includes(request.method || "GET") ? undefined : await readBody(request);
  let upstream;
  try {
    upstream = await fetch(targetUrl, { method: request.method, headers, body });
  } catch (error) {
    response.writeHead(502, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "ACCIO_GATEWAY_NETWORK", message: error?.message || String(error) }));
    return;
  }
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

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      provider: API_PROVIDER,
      protocol: API_PROTOCOL,
      model: MODEL,
      resolvedModel,
      endpoint: ENDPOINT,
      authType: AUTH_TYPE,
      reasoningEffort: REASONING_MODE,
      apiKeyConfigured: Boolean(process.env.OPENCODE_GO_API_KEY),
      imageEnabled: IMAGE_ENABLED,
      imageModel: IMAGE_MODEL || null,
      imageEndpoint: IMAGE_ENDPOINT || null,
    }));
    return;
  }
  const pathname = new URL(request.url || "/", `http://${HOST}:${PORT}`).pathname;
  const isLlm = request.method === "POST" && (
    (process.env.ACCIO_MODEL_PATHS || "").split(",").includes(pathname) ||
    pathname.startsWith("/api/adk/llm/generateContent") ||
    pathname.startsWith("/api/adk/llm/streamGenerateContent")
  );
  const isImageHttp = request.method === "POST" && (
    pathname === "/api/image/generate" ||
    pathname === "/api/image/edit" ||
    pathname === "/api/media/image/generate" ||
    pathname === "/api/media/image/edit"
  );
  if (isLlm || isImageHttp) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    try {
      const payload = await readJson(request);
      if (isImageHttp) await proxyImage(request, response, payload);
      else await proxy(request, response, payload);
    } catch (error) {
      if (!response.writableEnded) errorFrame(response, "ADAPTER_REQUEST", error?.message || String(error));
    }
    return;
  }
  if (request.url?.startsWith("/api/")) {
    await forwardGateway(request, response);
    return;
  }
  if (request.method !== "POST" || !request.url?.startsWith("/api/adk/llm/generateContent")) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Accio model bridge listening on http://${HOST}:${server.address().port}`);
  console.log(`provider=${API_PROVIDER}`);
  console.log(`model=${MODEL}`);
  console.log(`authType=${AUTH_TYPE}`);
  console.log(`protocol=${API_PROTOCOL}`);
  console.log(`reasoningEffort=${REASONING_MODE}`);
  console.log(`originalGateway=${ORIGINAL_GATEWAY}`);
  console.log(`apiKeyConfigured=${Boolean(process.env.OPENCODE_GO_API_KEY)}`);
  console.log(`imageEnabled=${IMAGE_ENABLED}`);
  console.log(`imageModel=${IMAGE_MODEL || "-"}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
