// Local-only fixture for exercising the packaged app via LaunchServices/Finder.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accio-switch-desktop-'));
  const mock = http.createServer(async (req, res) => {
    for await (const chunk of req) {};
    if (req.url === '/v1/chat/completions') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end('data: {"choices":[{"delta":{"content":"local desktop mock"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    } else { res.end('{"ok":true,"source":"local-only-fixture"}'); }
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const url = `http://127.0.0.1:${mock.address().port}`;
  async function freePort() { const s = http.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
  const env = { ACCIO_SWITCH_TEST_DIR: dir, ACCIO_SWITCH_TEST_RELAY_PORT: String(await freePort()), ACCIO_SWITCH_TEST_BRIDGE_PORT: String(await freePort()), ACCIO_ORIGINAL_GATEWAY_URL: url, ACCIO_LOCAL_GATEWAY_URL: url, ACCIO_MODEL_CACHE_PATH: path.join(dir, 'no-cache.json'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  const providers = ['a', 'b'].map(id => ({ id: `mock-${id}`, kind: 'custom_openai', name: `Local Mock ${id.toUpperCase()}`, endpoint: url + '/v1/chat/completions', model: `mock-${id}`, reasoningEffort: 'high', apiProtocol: 'chat_completions', hasKey: false }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ activeProviderId: 'mock-a', providers }));
  fs.writeFileSync(path.join(dir, 'launch-env.json'), JSON.stringify(env, null, 2));
  console.log(dir);
})();
