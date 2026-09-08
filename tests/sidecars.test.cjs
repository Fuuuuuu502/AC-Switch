const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const node = process.env.TEST_NODE || process.execPath;
const llm = '/api/adk/llm/generateContent';
const payload = { contents: [{ role: 'user', parts: [{ text: 'test' }] }] };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
async function server(t, handler) {
  const s = http.createServer(handler); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  t.after(() => { s.closeAllConnections(); s.close(); });
  return `http://127.0.0.1:${s.address().port}`;
}
async function sidecar(t, name, env) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'accio-sidecar-test-'));
  const child = spawn(node, [path.resolve('sidecar', name)], {
    env: { PATH: '/usr/bin:/bin', TMPDIR: temp, ACCIO_MODEL_CACHE_PATH: path.join(temp, 'missing-cache.json'), ...env,
      ACCIO_RELAY_PORT: '0', ACCIO_OPENCODE_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill('SIGKILL'); if (child.exitCode === null && child.signalCode === null) await once(child, 'exit'); await rm(temp, { recursive: true, force: true }); });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    child.stdout.on('data', b => { output += b; const m = output.match(/listening on (http:\/\/127.0.0.1:\d+)/); if (m) resolve(m[1]); });
    child.stderr.on('data', b => { output += b; });
    child.once('error', reject); child.once('exit', () => reject(new Error(output)));
  });
  assert.equal((await (await fetch(url + '/healthz')).json()).ok, true);
  return url;
}
function bridge(t, upstream, env = {}) {
  return sidecar(t, 'openai-bridge.cjs', { ACCIO_API_PROVIDER: 'custom_openai', OPENCODE_GO_MODEL: 'test-model', OPENCODE_GO_REASONING_EFFORT: 'high', OPENCODE_GO_API_KEY: 'mock-chat-key', OPENCODE_GO_ENDPOINT: upstream + '/v1/chat/completions', ACCIO_ORIGINAL_GATEWAY_URL: upstream, ...env });
}
async function body(req) { let data = ''; for await (const b of req) data += b; return data; }
async function post(url, data = payload, route = llm) {
  const r = await fetch(url + route, { method: 'POST', body: JSON.stringify(data), signal: AbortSignal.timeout(110000) });
  return r.text();
}
function frames(text) { return text.split('\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5))); }
function event(res, type, data) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); }
function chat(res, delta, finish = null) { res.write(`data: ${JSON.stringify({ id: 'mock', choices: [{ delta, finish_reason: finish }] })}\n\n`); }

test('Chat text, reasoning and assembled tool arguments', async t => {
  let input;
  const upstream = await server(t, async (req, res) => {
    input = JSON.parse(await body(req)); assert.equal(req.headers.authorization, 'Bearer mock-chat-key');
    res.setHeader('Content-Type', 'text/event-stream');
    chat(res, { reasoning_content: 'thinking' }); chat(res, { content: 'hello' });
    chat(res, { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{"x":' } }] });
    chat(res, { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, 'tool_calls'); res.end('data: [DONE]\n\n');
  });
  const result = frames(await post(await bridge(t, upstream)));
  assert.equal(input.model, 'test-model'); assert.equal(result[0].content.parts[0].thought, true);
  assert.equal(result[1].content.parts[0].text, 'hello');
  assert.deepEqual(result.at(-1).content.parts[0].functionCall, { id: 'call_1', name: 'lookup', argsJson: '{"x":1}' });
});

test('Responses text, multimodal input and tool item/call IDs', async t => {
  let input;
  const upstream = await server(t, async (req, res) => {
    assert.equal(req.url, '/v1/responses'); input = JSON.parse(await body(req));
    res.setHeader('Content-Type', 'text/event-stream');
    event(res, 'response.output_text.delta', { delta: 'hello' });
    event(res, 'response.output_item.added', { item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '' } });
    event(res, 'response.function_call_arguments.delta', { item_id: 'fc_1', delta: '{"x":1}' });
    event(res, 'response.function_call_arguments.done', { item_id: 'fc_1', arguments: '{"x":1}' });
    event(res, 'response.completed', { response: { status: 'completed' } }); res.end();
  });
  const url = await bridge(t, upstream, { ACCIO_API_PROTOCOL: 'responses' });
  const result = frames(await post(url, { contents: [{ role: 'user', parts: [{ text: 'describe' }, { inlineData: { data: png, mimeType: 'image/png' } }] }] }));
  assert.equal(input.input[0].content[0].type, 'input_text'); assert.equal(input.input[0].content[1].type, 'input_image');
  assert.equal(result[0].content.parts[0].text, 'hello');
  assert.deepEqual(result.at(-1).content.parts, [{ functionCall: { id: 'call_1', name: 'lookup', argsJson: '{"x":1}' } }]);
});
for (const type of ['error', 'response.failed', 'response.incomplete', 'EOF']) {
  test(`Responses ${type} is not success`, async t => {
    const upstream = await server(t, async (req, res) => { await body(req); if (type !== 'EOF') event(res, type, { message: 'mock failure' }); res.end(); });
    const result = frames(await post(await bridge(t, upstream, { ACCIO_API_PROTOCOL: 'responses' })));
    assert.equal(result.at(-1).errorCode, 'UPSTREAM_RESPONSES');
  });
}
for (const protocol of ['chat_completions', 'responses']) {
  test(`${protocol} upstream HTTP error`, async t => {
    const upstream = await server(t, async (req, res) => { await body(req); res.writeHead(401); res.end(JSON.stringify({ error: { message: 'mock unauthorized' } })); });
    const result = frames(await post(await bridge(t, upstream, { ACCIO_API_PROTOCOL: protocol })));
    assert.equal(result.at(-1).errorCode, 'UPSTREAM_HTTP_401');
  });
}

test('disabled image channel never reaches text upstream', async t => {
  let calls = 0;
  const upstream = await server(t, (req, res) => { calls++; res.end('{}'); });
  const url = await bridge(t, upstream);
  for (const route of [llm, '/api/image/generate', '/api/media/image/edit']) {
    const result = frames(await post(url, { ...payload, generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }, route));
    assert.equal(result[0].errorCode, 'CONFIG'); assert.match(result[0].errorMessage, /图片通道未启用/);
  }
  assert.equal(calls, 0);
});
for (const ownKey of [true, false]) {
  test(`image generation and edit, independent key=${ownKey}`, async t => {
    const requests = [];
    const upstream = await server(t, async (req, res) => { requests.push({ url: req.url, auth: req.headers.authorization, data: await body(req) }); res.end(JSON.stringify({ data: [{ b64_json: png }] })); });
    const url = await bridge(t, upstream, { ACCIO_IMAGE_ENABLED: 'true', OPENCODE_GO_IMAGE_MODEL: 'gpt-image-1', OPENCODE_GO_IMAGE_ENDPOINT: upstream + '/v1/images/generations', OPENCODE_GO_IMAGE_API_KEY: ownKey ? 'mock-image-key' : '' });
    for (const data of [{ prompt: 'test' }, { prompt: 'edit', image: `data:image/png;base64,${png}` }]) {
      const result = frames(await post(url, data, '/api/image/generate'));
      assert.equal(result.at(-1).content.parts[1].inlineData.data, png);
    }
    assert.deepEqual(requests.map(r => r.url), ['/v1/images/generations', '/v1/images/edits']);
    for (const r of requests) { assert.equal(r.auth, `Bearer ${ownKey ? 'mock-image-key' : 'mock-chat-key'}`); assert.ok(!r.data.includes('response_format')); }
  });
}

test('relay official/custom/default/local routing and catalog fallback body', async t => {
  const upstream = await server(t, async (req, res) => { res.end(JSON.stringify({ target: 'official', body: await body(req) })); });
  const local = await server(t, async (req, res) => { res.end(JSON.stringify({ target: 'local' })); });
  const model = await server(t, async (req, res) => { res.end(JSON.stringify({ target: 'model' })); });
  for (const mode of ['official', 'custom']) {
    const url = await sidecar(t, 'gateway-relay.cjs', { ACCIO_ROUTE_MODE: mode, ACCIO_ORIGINAL_GATEWAY_URL: upstream, ACCIO_LOCAL_GATEWAY_URL: local, ACCIO_MODEL_BRIDGE_URL: model });
    for (const [route, target] of [[llm, mode === 'official' ? 'official' : 'model'], ['/api/image/generate', mode === 'official' ? 'official' : 'model'], ['/unknown', 'official'], ['/skills/catalog', 'local'], ['/mcp-servers', 'local']]) {
      assert.equal(JSON.parse(await post(url, payload, route)).target, target);
    }
    const catalog = JSON.parse(await post(url, { test: 'preserved' }, '/api/llm/config/v2'));
    assert.equal(catalog.target, 'official'); assert.equal(catalog.body, '{"test":"preserved"}');
  }
});

test('12-second pings preserve >90-second silence through relay', { timeout: 110000 }, async t => {
  const upstream = await server(t, async (req, res) => {
    await body(req); res.setHeader('Content-Type', 'text/event-stream'); res.flushHeaders();
    const timer = setTimeout(() => { chat(res, { content: 'after silence' }, 'stop'); res.end('data: [DONE]\n\n'); }, 92000);
    res.on('close', () => clearTimeout(timer));
  });
  const model = await bridge(t, upstream);
  const url = await sidecar(t, 'gateway-relay.cjs', { ACCIO_ORIGINAL_GATEWAY_URL: upstream, ACCIO_MODEL_BRIDGE_URL: model });
  const start = Date.now(); const arrivals = []; let output = '';
  const res = await fetch(url + llm, { method: 'POST', body: JSON.stringify(payload), signal: AbortSignal.timeout(105000) });
  for await (const chunk of res.body) { arrivals.push(Date.now() - start); output += Buffer.from(chunk); }
  assert.ok(Date.now() - start >= 90000); assert.ok((output.match(/: ping/g) || []).length >= 7);
  assert.ok(arrivals[0] < 15000); for (let i = 1; i < arrivals.length; i++) assert.ok(arrivals[i] - arrivals[i - 1] < 16000);
  assert.equal(frames(output)[0].content.parts[0].text, 'after silence');
});
