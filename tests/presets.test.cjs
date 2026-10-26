const test = require('node:test');
const assert = require('node:assert/strict');
const presets = require('../src/provider-presets.json');
const { reasoningOptions } = require('../sidecar/reasoning-options.cjs');
const expected = {
  opencode: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
  openai: {},
  deepseek: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
  qwen: { enable_thinking: false },
  zhipu: { thinking: { type: 'enabled' } },
  kimi: { reasoning_effort: 'high' },
  novaferry: { reasoning_effort: 'high' },
};
for (const p of presets) test(`${p.name}: default model reasoning request`, () => {
  assert.equal(new URL(p.endpoint).protocol, 'https:');
  assert.ok(p.endpoint.endsWith('/chat/completions'));
  assert.ok(p.efforts.includes(p.reasoningEffort));
  assert.deepEqual(reasoningOptions(p.endpoint, p.models[0], p.reasoningEffort), expected[p.id]);
});
test('unknown custom endpoints retain legacy reasoning; hostname lookalikes are not official', () => {
  const expected = { thinking: { type: 'disabled' } };
  assert.deepEqual(reasoningOptions('http://localhost:1234/v1/chat/completions', 'local', 'disabled'), expected);
  assert.deepEqual(reasoningOptions('https://api.openai.com.example.org/v1/chat/completions', 'local', 'disabled'), expected);
});
test('OpenAI reasoning effort is preserved without silently lowering max', () => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    assert.deepEqual(reasoningOptions('https://api.openai.com/v1/chat/completions', 'gpt-6-astra', effort), { reasoning_effort: effort });
  }
});
test('Qwen and GLM enable reasoning without unsupported effort; K3 never sends thinking', () => {
  assert.deepEqual(reasoningOptions(presets[3].endpoint, 'qwen3.8-max', 'high'), { enable_thinking: true });
  assert.deepEqual(reasoningOptions(presets[4].endpoint, 'glm-5.3', 'disabled'), { thinking: { type: 'disabled' } });
  for (const effort of ['low', 'high', 'max']) assert.deepEqual(reasoningOptions(presets[5].endpoint, 'kimi-k3', effort), { reasoning_effort: effort });
});
test('Novaferry passes OpenAI-style reasoning effort only', () => {
  const novaferry = presets.find(p => p.id === 'novaferry');
  assert.deepEqual(reasoningOptions(novaferry.endpoint, 'claude-opus-5-5', 'disabled'), {});
  for (const effort of novaferry.efforts.filter(e => e !== 'disabled')) assert.deepEqual(reasoningOptions(novaferry.endpoint, 'gpt-6.1-sol', effort), { reasoning_effort: effort });
});
