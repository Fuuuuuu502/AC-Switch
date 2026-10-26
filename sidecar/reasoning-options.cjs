// Official hosts use their documented Chat Completions reasoning parameters.
// Unknown compatible services retain the existing DeepSeek-style contract.
function reasoningOptions(endpoint, model, effort) {
  const host = new URL(endpoint).hostname;
  const enabled = effort !== 'disabled';
  if (host === 'api.openai.com' || host === 'api.novaferry.com') {
    return enabled ? { reasoning_effort: effort } : {};
  }
  if (host === 'dashscope.aliyuncs.com' || host === 'dashscope-intl.aliyuncs.com' || host.endsWith('.maas.aliyuncs.com')) {
    return { enable_thinking: enabled };
  }
  if (host === 'open.bigmodel.cn') return { thinking: { type: enabled ? 'enabled' : 'disabled' } };
  if (host === 'api.moonshot.cn' && model === 'kimi-k3') {
    return { reasoning_effort: enabled ? effort : 'low' };
  }
  if (host === 'api.moonshot.cn') return { thinking: { type: enabled ? 'enabled' : 'disabled' } };
  return { thinking: { type: enabled ? 'enabled' : 'disabled' }, ...(enabled ? { reasoning_effort: effort } : {}) };
}
module.exports = { reasoningOptions };
