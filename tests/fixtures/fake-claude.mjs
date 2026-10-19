#!/usr/bin/env node
// Synthetic stand-in for the Claude CLI used by offline tests. It never calls
// a model. The scenario is chosen by a marker in the prompt: [[scenario:NAME]].
// Optional markers: [[write:relative/path]] creates a file in the worktree;
// [[envdump:absolute-path]] records environment variable NAMES (plus a hash of
// ANTHROPIC_AUTH_TOKEN) so tests can check credential isolation without values.
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const marker = (name) => [...prompt.matchAll(new RegExp(`\\[\\[${name}:([^\\]]+)\\]\\]`, 'g'))].map((m) => m[1]);
const scenario = marker('scenario')[0] ?? 'ok';
const modelArg = process.argv[process.argv.indexOf('--model') + 1];
const model = process.argv.includes('--model') ? modelArg : 'claude-default';
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const file of marker('write')) {
  mkdirSync(path.dirname(path.join(process.cwd(), file)), { recursive: true });
  writeFileSync(path.join(process.cwd(), file), `written by fake worker (${scenario})\n`);
}
for (const target of marker('envdump')) {
  const token = process.env.ANTHROPIC_AUTH_TOKEN;
  writeFileSync(target, JSON.stringify({
    names: Object.keys(process.env).sort(),
    baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
    authTokenSha256: token ? createHash('sha256').update(token).digest('hex') : null,
    maxOutputTokens: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? null,
    nonessential: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null,
    args: process.argv.slice(2).filter((arg) => arg.startsWith('--')),
  }));
}

const reportedModel = scenario === 'model-mismatch' ? 'deepseek-pro-v4' : model;
const partial = process.argv.includes('--include-partial-messages');
emit({ type: 'system', subtype: 'init', model: reportedModel });

// Mirrors the real CLI: assistant events carry message_start usage, where
// output_tokens is a placeholder (1); with --include-partial-messages the raw
// stream adds message_delta with the cumulative output count.
function apiMessage(id, { input, cacheRead = 0, cacheWrite = 0, output }, blocks) {
  const startUsage = { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: 1 };
  if (partial) {
    emit({ type: 'stream_event', event: { type: 'message_start', message: { id, model: reportedModel, usage: startUsage } } });
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial text' } } });
    emit({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: output } } });
  }
  for (const block of blocks) emit({ type: 'assistant', message: { id, model: reportedModel, role: 'assistant', content: [block], usage: startUsage } });
}

if (scenario === 'overspend') {
  for (let i = 1; i <= 400; i += 1) {
    apiMessage(`msg_${i}`, { input: 100000, output: 1000 }, [{ type: 'text', text: `step ${i}` }]);
    await sleep(25);
  }
  process.exit(0);
}

if (scenario === 'huge-context') {
  apiMessage('msg_1', { input: 300000, output: 10 }, [{ type: 'text', text: 'large context' }]);
  await sleep(10_000);
  process.exit(0);
}

if (scenario === 'slow') {
  apiMessage('msg_1', { input: 10, output: 5 }, [{ type: 'text', text: 'working slowly' }]);
  await sleep(60_000);
  process.exit(0);
}

// One API message with two content blocks: the CLI repeats its usage per block.
apiMessage('msg_1', { input: 1000, output: 200 }, [{ type: 'text', text: 'part one' }, { type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }]);
emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
apiMessage('msg_2', { input: 500, cacheRead: 1000, output: 100 }, [{ type: 'text', text: 'part two' }]);

if (scenario === 'no-result') process.exit(0);

emit({
  type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: `Fake worker finished (${scenario}).`, total_cost_usd: 0.05,
  usage: { input_tokens: 1500, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 300 },
  modelUsage: { [reportedModel]: { inputTokens: 1500, outputTokens: 300, cacheReadInputTokens: 1000, cacheCreationInputTokens: 0, costUSD: 0.05 } },
});
