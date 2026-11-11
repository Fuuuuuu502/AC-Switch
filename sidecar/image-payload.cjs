"use strict";
// 判断 Accio 的请求是不是生图 / 改图。模型桥和中继共用：
// 中继在「对话用官方」时靠它把生图请求单独交给图片通道。

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

// Accio 的生图（image_generate / image_edit 走 AccioLlm）会把 generationConfig 转成 JSON 字符串放进
// properties.generationConfig，并在 properties.media_operation 里标明 IMAGE_GENERATION / IMAGE_EDIT
function imageGenerationConfig(payload) {
  const properties = payload?.properties;
  const candidates = [
    payload?.generationConfig,
    payload?.generation_config,
    parseMaybeJson(properties?.generationConfig),
    parseMaybeJson(properties?.generation_config),
  ];
  return candidates.find((item) => item && typeof item === "object") || {};
}

function isImagePayload(payload) {
  const generationConfig = imageGenerationConfig(payload);
  const responseModalities = generationConfig.responseModalities ?? generationConfig.response_modalities;
  if (Array.isArray(responseModalities) && responseModalities.some((item) => String(item).trim().toUpperCase() === "IMAGE")) {
    return true;
  }
  const operation = String(payload?.properties?.media_operation || "").trim().toUpperCase();
  if (operation === "IMAGE_GENERATION" || operation === "IMAGE_EDIT") return true;
  return Boolean(payload?.prompt && (payload?.image || payload?.images || payload?.mask));
}

module.exports = { parseMaybeJson, imageGenerationConfig, isImagePayload };
