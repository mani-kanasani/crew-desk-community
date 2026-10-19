import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import { createServer, loadConfigFromFile } from 'vite';

test('dev proxy preserves matching Host/Origin and does not launder foreign origins', async () => {
  const backend = httpServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin }));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  let vite;
  try {
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' });
    const proxy = loaded.config.server.proxy['/api'];
    assert.equal(typeof proxy, 'object');
    vite = await createServer({
      configFile: false, logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, watch: null, proxy: {
        '/api': { ...proxy, target: `http://127.0.0.1:${backend.address().port}` },
      } },
    });
    await vite.listen();
    const host = `127.0.0.1:${vite.httpServer.address().port}`;
    for (const origin of [`http://${host}`, 'https://untrusted.example']) {
      const response = await fetch(`http://${host}/api/probe`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.deepEqual(await response.json(), { host, origin });
    }
  } finally {
    if (vite) await vite.close();
    await new Promise(resolve => backend.close(resolve));
  }
});
