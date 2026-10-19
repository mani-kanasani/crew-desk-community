import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { serverUrl, summarizeRun } from '../bin/client.mjs';

test('local command client rejects remote hosts and credentials', () => {
  const original = process.env.HARNESS_URL;
  try {
    for (const url of ['https://example.com', 'http://127.0.0.1.evil.test', 'http://user:pass@localhost']) {
      process.env.HARNESS_URL = url;
      assert.throws(() => serverUrl(), /loopback/);
    }
    process.env.HARNESS_URL = 'http://127.0.0.1:5555';
    assert.equal(serverUrl(), 'http://127.0.0.1:5555');
  } finally { if (original === undefined) delete process.env.HARNESS_URL; else process.env.HARNESS_URL = original; }
});

test('compact status omits task input, transcript, result text and diff', () => {
  const result = summarizeRun({ id: 'x', prompt: 'private input', logs: [{message:'log'}], diff: 'patch', status: 'running' });
  assert.deepEqual(result, { id: 'x', status: 'running', logCount: 1, hasDiff: true, hasResult: false });
});

test('MCP exposes control tools and uses the same HTTP queue contract', async () => {
  const observed = [];
  const api = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    observed.push({ method: req.method, path: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/state') res.end(JSON.stringify({ projects:[],providers:[],runs:[{id:'run-1',logs:[],diff:'',status:'completed'}] }));
    else if (req.url === '/api/runs') res.end(JSON.stringify({ run:{id:'new-run',status:'queued'} }));
    else { res.statusCode=404;res.end(JSON.stringify({error:'Run not found'})); }
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../bin/mcp.mjs', import.meta.url))],
    env: { ...process.env, HARNESS_URL: `http://127.0.0.1:${api.address().port}` },
    stderr: 'pipe',
  });
  const client = new Client({name:'crew-test',version:'1.0.0'});
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(t=>t.name).sort(), ['crew_cancel','crew_demo','crew_diff','crew_project_add','crew_result','crew_run','crew_status']);
    const state = await client.callTool({name:'crew_status',arguments:{}});
    assert.equal(JSON.parse(state.content[0].text).runs[0].id, 'run-1');
    await client.callTool({name:'crew_run',arguments:{title:'Review',prompt:'Inspect tests',projectId:'p1',provider:'claude',mode:'read'}});
    assert.equal(observed[1].method, 'POST');
    assert.equal(JSON.parse(observed[1].body).provider, 'claude');
    const missing = await client.callTool({name:'crew_result',arguments:{runId:'missing'}});
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text,/Run not found/);
  } finally { await client.close(); await new Promise(resolve=>api.close(resolve)); }
});
