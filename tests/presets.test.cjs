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
test('Qwen and GLM enable reasoning without unsupported effort; K3 never sends thinking', () => {
  assert.deepEqual(reasoningOptions(presets[3].endpoint, 'qwen3.8-max', 'high'), { enable_thinking: true });
  assert.deepEqual(reasoningOptions(presets[4].endpoint, 'glm-5.3', 'disabled'), { thinking: { type: 'disabled' } });
  for (const effort of ['low', 'high', 'max']) assert.deepEqual(reasoningOptions(presets[5].endpoint, 'kimi-k3', effort), { reasoning_effort: effort });
});
