// Phase 0 readiness checks: immutable per-run snapshots, worker context and
// scope, credential isolation, usage categories, and cumulative budget
// admission/settlement. Everything here is offline: a synthetic CLI fixture
// stands in for Claude, and prices are synthetic test values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createHarnessServer } from '../server/index.mjs';
import { createUsageTracker, estimateCostUsd } from '../server/usage.mjs';
import { openBudgetLedger } from '../server/budget.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const CARD = { status: 'verified', currency: 'USD', inputPerMTok: 0.3, cacheReadPerMTok: 0.03, cacheWritePerMTok: null, outputPerMTok: 1.2, contextWindowTokens: 128000, sources: ['synthetic test price'], checkedAt: '2026-09-21' };
const POLICY = { perTaskMaxUsd: 1, defaultTargetUsd: 0.2, maxOutputTokensPerCall: 8000, headroomCalls: 2, contextBoundTokens: 128000, autoCompactWindowTokens: 100000 };
const PRICING = {
  deepseek: { ...POLICY, models: { 'deepseek-flash': CARD } },
  kimi: { ...POLICY, models: { 'kimi-k3': { ...CARD, aliases: ['kimi-k3[1m]'] } } },
};
// Reservation for target 0.2: worst call = 128000×0.3 + 8000×1.2 = 48000 µ$ → 2 calls = 0.096.
const RESERVATION_FOR_0_2 = 0.296;
const SYNTHETIC_KEYS = { DEEPSEEK_API_KEY: 'synthetic-deepseek-key-000000', MOONSHOT_API_KEY: 'synthetic-kimi-key-000000' };

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withEnv(values) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return () => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
}

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim(); }

async function initRepo(dir) {
  await mkdir(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'fixture@localhost']);
  git(dir, ['config', 'user.name', 'Fixture']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(dir, 'README.md'), 'fixture\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'first']);
  return git(dir, ['rev-parse', 'HEAD']);
}

async function request(url, pathname, body) {
  const response = await fetch(`${url}${pathname}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function waitFor(check, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await sleep(40);
  }
}

async function setup({ pricing = PRICING, dataDir: existingDataDir, root: existingRoot } = {}) {
  const root = existingRoot ?? await mkdtemp(path.join(tmpdir(), 'crew-p0-'));
  const dataDir = existingDataDir ?? path.join(root, 'data');
  const repo = path.join(root, 'repo');
  const first = existingRoot ? git(repo, ['rev-parse', 'HEAD']) : await initRepo(repo);
  const pricingFile = path.join(root, 'pricing.json');
  await writeFile(pricingFile, JSON.stringify(pricing));
  const app = await createHarnessServer({ rootDir: root, dataDir, pricingFile, claudeCommand: { bin: process.execPath, args: [FIXTURE] } });
  const url = await app.start(0);
  const project = (await request(url, '/api/projects', { path: repo, name: 'fixture' })).body.project;
  return { root, dataDir, repo, first, app, url, project, async close() { await app.close(); }, async cleanup() { await app.close().catch(() => {}); await rm(root, { recursive: true, force: true, maxRetries: 5 }); } };
}

async function finished(ctx, runId) {
  return waitFor(async () => {
    const { body } = await request(ctx.url, `/api/runs/${runId}`);
    return ['completed', 'failed', 'cancelled', 'interrupted'].includes(body.run?.status) ? body.run : null;
  });
}

const task = (ctx, extra) => ({ title: 'Fixture task', prompt: '[[scenario:ok]] Do the fixture task.', provider: 'deepseek', projectId: ctx.project.id, mode: 'read', maxTurns: 3, timeoutSeconds: 60, ...extra });

test('usage tracker deduplicates repeated message usage and prefers final per-model totals', () => {
  const tracker = createUsageTracker();
  const usage = { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 200 };
  tracker.observe({ type: 'assistant', message: { id: 'm1', model: 'x', usage } });
  tracker.observe({ type: 'assistant', message: { id: 'm1', model: 'x', usage } });
  tracker.observe({ type: 'assistant', message: { id: 'm2', model: 'x', usage: { input_tokens: 5, output_tokens: 1 } } });
  let snap = tracker.snapshot();
  assert.equal(snap.completeness, 'partial');
  assert.deepEqual(snap.totals, { inputTokens: 1005, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 201 });
  assert.deepEqual(snap.missingCategories.sort(), ['cacheReadTokens', 'cacheWriteTokens']);
  tracker.observe({ type: 'result', usage: { input_tokens: 1 }, modelUsage: { x: { inputTokens: 2000, outputTokens: 300, cacheReadInputTokens: 10, cacheCreationInputTokens: 0 } } });
  snap = tracker.snapshot();
  assert.equal(snap.completeness, 'reported');
  assert.deepEqual(snap.totals, { inputTokens: 2000, cacheReadTokens: 10, cacheWriteTokens: 0, outputTokens: 300 }, 'final totals replace, never add to, in-flight observations');
  const streamed = createUsageTracker();
  streamed.observe({ type: 'stream_event', event: { type: 'message_start', message: { id: 's1', model: 'x', usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } } });
  streamed.observe({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 900 } } });
  streamed.observe({ type: 'assistant', message: { id: 's1', model: 'x', usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } });
  assert.equal(streamed.snapshot().totals.outputTokens, 900, 'message_delta output replaces the assistant-event placeholder');
  assert.equal(streamed.snapshot().maxCallContextTokens, 50);
  const rekey = createUsageTracker();
  rekey.observe({ type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 70, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } } });
  rekey.observe({ type: 'assistant', message: { id: 'real-id', usage: { input_tokens: 70, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } });
  rekey.observe({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 40 } } });
  assert.equal(rekey.snapshot().apiMessages, 1, 'an id-less message_start and its named blocks are one message');
  assert.deepEqual(rekey.snapshot().totals, { inputTokens: 70, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 40 });
  const empty = createUsageTracker().snapshot();
  assert.equal(empty.completeness, 'unknown');
  assert.equal(empty.totals.inputTokens, null, 'unknown is not zero');
});

test('cost estimate uses exact micro-dollar arithmetic and flags unknown categories', () => {
  assert.deepEqual(estimateCostUsd({ inputTokens: 1500, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 300 }, CARD), { usd: 0.00084, complete: true, missing: [] });
  const partial = estimateCostUsd({ inputTokens: 1000, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: 10 }, CARD);
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.missing, ['cacheReadTokens', 'cacheWriteTokens']);
  assert.equal(estimateCostUsd({ inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null }, CARD).usd, null, 'nothing reported is unknown, not $0');
});

test('ledger admits atomically, rejects over-allocation, recovers after restart and never resets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'crew-ledger-'));
  const file = path.join(root, 'ledger.json');
  const pricingFile = path.join(root, 'pricing.json');
  await writeFile(pricingFile, JSON.stringify(PRICING));
  try {
    let ledger = await openBudgetLedger({ file, pricingFile, allocations: { deepseek: 0.5, kimi: 1 } });
    const attempts = await Promise.all([1, 2, 3].map((n) => ledger.reserve({ provider: 'deepseek', runId: `r${n}`, model: 'deepseek-flash', targetUsd: 0.2 })));
    assert.equal(attempts.filter((a) => a.ok).length, 1, 'only one paid reservation may be active');
    const first = attempts.find((a) => a.ok).entry;
    assert.equal(first.reservedMicros / 1e6, RESERVATION_FOR_0_2);
    assert.match(attempts.find((a) => !a.ok).reason, /One paid run per provider/);
    const parallelKimi = await ledger.reserve({ provider: 'kimi', runId: 'k0', model: 'kimi-k3', targetUsd: 0.1 });
    assert.equal(parallelKimi.ok, true, 'a different provider may run in parallel');
    await ledger.close(parallelKimi.entry.id, { neverStarted: true, reason: 'test' });
    assert.match((await ledger.reserve({ provider: 'deepseek', runId: 'big', model: 'deepseek-flash', targetUsd: 5 })).reason, /per-task maximum/);
    assert.match((await ledger.reserve({ provider: 'deepseek', runId: 'x', model: 'unknown-model', targetUsd: 0.1 })).reason, /no verified USD price card/);

    await ledger.markDispatched(first.id);
    const settled = await ledger.close(first.id, { usage: { completeness: 'reported', totals: { inputTokens: 1500, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 300 } }, outcome: { code: 'ok' }, modelsMatch: true });
    assert.equal(settled.status, 'settled');
    assert.equal(settled.settledMicros, 840);

    const second = (await ledger.reserve({ provider: 'deepseek', runId: 'r4', model: 'deepseek-flash', targetUsd: 0.2 })).entry;
    await ledger.markDispatched(second.id);
    const uncertain = await ledger.close(second.id, { usage: null, outcome: { code: 'cli_failure' } });
    assert.equal(uncertain.status, 'uncertain', 'missing usage is not zero');
    assert.equal(ledger.summary().providers.deepseek.uncertainUsd, RESERVATION_FOR_0_2, 'uncertain keeps its reservation');

    const rejected = await ledger.reserve({ provider: 'deepseek', runId: 'r5', model: 'deepseek-flash', targetUsd: 0.2 });
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /would exceed the 0.5 USD allocation/);

    await assert.rejects(ledger.reconcile(second.id, { actualUsd: 0.01 }), /source is required/);
    await assert.rejects(ledger.reconcile(second.id, { actualUsd: -0.0000004, source: 'synthetic' }), /non-negative/);
    const reconciled = await ledger.reconcile(second.id, { actualUsd: 0.01, source: 'synthetic provider usage page' });
    assert.equal(reconciled.status, 'reconciled');
    const third = await ledger.reserve({ provider: 'deepseek', runId: 'r6', model: 'deepseek-flash', targetUsd: 0.2 });
    assert.equal(third.ok, true, 'reconciliation frees the uncertain exposure');
    await ledger.markDispatched(third.entry.id);

    ledger = await openBudgetLedger({ file, pricingFile, allocations: { deepseek: 999, kimi: 999 } });
    assert.equal(ledger.summary().providers.deepseek.allocationUsd, 0.5, 'persisted allocations are never overwritten');
    assert.equal(await ledger.recoverAfterRestart(), 1);
    assert.equal(ledger.entry(third.entry.id).status, 'uncertain', 'dispatched work interrupted by restart stays uncertain');
    const undispatched = (await ledger.reserve({ provider: 'kimi', runId: 'k1', model: 'kimi-k3[1m]', targetUsd: 0.2 })).entry;
    ledger = await openBudgetLedger({ file, pricingFile });
    await ledger.recoverAfterRestart();
    assert.equal(ledger.entry(undispatched.id).status, 'released', 'never-dispatched reservations are released');

    await assert.rejects(ledger.setAllocation('deepseek', 0.1, 'too low'), /Cannot set deepseek below/);
    await assert.rejects(ledger.setAllocation('kimi', 5, ''), /reason/);
    assert.equal(await ledger.setAllocation('kimi', 5, 'owner raised the allocation'), 5);
    assert.equal(ledger.summary().providers.kimi.allocationUsd, 5);

    await writeFile(file, '{ corrupt');
    await assert.rejects(openBudgetLedger({ file, pricingFile }), /was not reset/);
    assert.equal(await readFile(file, 'utf8'), '{ corrupt', 'a corrupt ledger is left untouched');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('paid run settles from CLI-reported per-model usage; child gets only its own credential', async () => {
  const restore = withEnv({ ...SYNTHETIC_KEYS, CLAUDE_CODE_MESSAGING_TOKEN: 'lead-session-token', CLAUDE_CODE_SESSION_ID: 'lead-session', ANTHROPIC_API_KEY: 'lead-api-key', OPENAI_API_KEY: 'other-key', SOME_SERVICE_SECRET: 'x' });
  const ctx = await setup();
  try {
    const dump = path.join(ctx.root, 'env.json');
    const created = await request(ctx.url, '/api/runs', task(ctx, { prompt: `[[scenario:ok]] [[envdump:${dump}]] Report.` }));
    assert.equal(created.status, 202, JSON.stringify(created.body));
    assert.equal(created.body.run.budget.status, 'reserved');
    assert.equal(created.body.run.sourceCommit, ctx.first);
    const run = await finished(ctx, created.body.run.id);
    assert.equal(run.status, 'completed', run.error);
    assert.equal(run.usage.completeness, 'reported');
    assert.deepEqual(run.usage.totals, { inputTokens: 1500, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 300 });
    assert.equal(run.usage.requestedModel, 'deepseek-flash');
    assert.deepEqual(run.usage.reportedModels, ['deepseek-flash']);
    assert.equal(run.usage.modelsMatch, true);
    assert.equal(run.usage.providerEstimateUsd, 0.00084);
    assert.equal(run.usage.cliReportedCostUsd, 0.05, 'CLI estimate kept separately, not used as the provider charge');
    assert.equal(run.budget.status, 'settled');
    assert.equal(run.budget.settledUsd, 0.00084);
    const state = (await request(ctx.url, '/api/state')).body;
    assert.equal(state.budget.providers.deepseek.settledUsd, 0.00084);
    assert.equal(state.budget.providers.deepseek.reservedUsd, 0);

    const env = JSON.parse(await readFile(dump, 'utf8'));
    assert.equal(env.baseUrl, 'https://api.deepseek.com/anthropic');
    assert.equal(env.authTokenSha256, sha256(SYNTHETIC_KEYS.DEEPSEEK_API_KEY));
    assert.equal(env.nonessential, '1');
    assert.equal(env.maxOutputTokens, '8000');
    assert.ok(env.names.includes('CLAUDE_CODE_AUTO_COMPACT_WINDOW') && env.names.includes('CLAUDE_CODE_DISABLE_TERMINAL_TITLE'));
    assert.ok(env.args.includes('--include-partial-messages'));
    for (const name of ['CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ID', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SOME_SERVICE_SECRET', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY']) {
      assert.ok(!env.names.includes(name), `${name} must not reach a worker`);
    }
    assert.ok(env.args.includes('--safe-mode') && !env.args.includes('--max-budget-usd'), 'paid lane relies on the provider-priced guard, not the CLI rate table');

    const claudeDump = path.join(ctx.root, 'env-claude.json');
    const claudeRun = await request(ctx.url, '/api/runs', task(ctx, { provider: 'claude', model: 'sonnet', prompt: `[[scenario:ok]] [[envdump:${claudeDump}]]` }));
    assert.equal(claudeRun.body.run.budget, undefined, 'subscription runs are not charged to the API ledger');
    await finished(ctx, claudeRun.body.run.id);
    const claudeEnv = JSON.parse(await readFile(claudeDump, 'utf8'));
    assert.equal(claudeEnv.authTokenSha256, null);
    assert.ok(claudeEnv.args.includes('--model'), 'an explicitly requested Claude model is passed through');
    assert.ok(!claudeEnv.names.some((name) => /^(ANTHROPIC_|CLAUDE_CODE_MESSAGING|DEEPSEEK|MOONSHOT)/.test(name)));
  } finally { restore(); await ctx.cleanup(); }
});

test('in-flight guard stops at the task target; incomplete outcomes stay uncertain', async () => {
  const restore = withEnv(SYNTHETIC_KEYS);
  const ctx = await setup();
  try {
    const stopped = await finished(ctx, (await request(ctx.url, '/api/runs', task(ctx, { prompt: '[[scenario:overspend]]', budgetUsd: 0.1 }))).body.run.id);
    assert.equal(stopped.status, 'failed');
    assert.match(stopped.error, /paid-lane guard/);
    assert.ok(stopped.usage.totals.outputTokens >= 1000, 'streamed output counts, not placeholders');
    assert.equal(stopped.budget.status, 'uncertain');
    assert.ok(stopped.usage.totals.inputTokens >= 100000);
    assert.ok(stopped.liveEstimateUsd >= 0.1);

    const huge = await finished(ctx, (await request(ctx.url, '/api/runs', task(ctx, { prompt: '[[scenario:huge-context]]' }))).body.run.id);
    assert.equal(huge.status, 'failed');
    assert.ok(huge.logs.some((log) => /above the reservation bound/.test(log.message)));
    assert.equal(huge.budget.status, 'uncertain');

    const noResult = await finished(ctx, (await request(ctx.url, '/api/runs', task(ctx, { prompt: '[[scenario:no-result]]' }))).body.run.id);
    assert.equal(noResult.budget.status, 'uncertain');
    assert.equal(noResult.usage.completeness, 'partial');

    const mismatch = await finished(ctx, (await request(ctx.url, '/api/runs', task(ctx, { prompt: '[[scenario:model-mismatch]]' }))).body.run.id);
    assert.equal(mismatch.usage.modelsMatch, false);
    assert.deepEqual(mismatch.usage.reportedModels, ['deepseek-pro-v4']);
    assert.equal(mismatch.budget.status, 'uncertain');
    assert.match(mismatch.budget.reason, /reported model differs/);

    const summary = (await request(ctx.url, '/api/budget')).body.budget.providers.deepseek;
    assert.ok(summary.uncertainUsd > 0 && summary.reservedUsd === 0);
    assert.equal(Math.round((summary.allocationUsd - summary.settledUsd - summary.uncertainUsd) * 1e6), Math.round(summary.remainingUsd * 1e6));
  } finally { restore(); await ctx.cleanup(); }
});

test('admission rejects unsafe paid runs; cancelling a queued paid run releases its reservation', async () => {
  const restore = withEnv(SYNTHETIC_KEYS);
  const unverified = { ...PRICING, deepseek: { ...POLICY, models: { 'deepseek-flash': { ...CARD, status: 'unverified' } } } };
  const ctx = await setup({ pricing: unverified });
  try {
    const paused = await request(ctx.url, '/api/runs', task(ctx));
    assert.equal(paused.status, 409);
    assert.match(paused.body.error, /no verified USD price card/);
    const tooBig = await request(ctx.url, '/api/runs', task(ctx, { provider: 'kimi', model: 'kimi-k3[1m]', budgetUsd: 2 }));
    assert.equal(tooBig.status, 409);
    assert.match(tooBig.body.error, /per-task maximum/);
    await request(ctx.url, '/api/budget/providers/kimi/pause', { reason: 'test pause' });
    assert.match((await request(ctx.url, '/api/runs', task(ctx, { provider: 'kimi', model: 'kimi-k3[1m]' }))).body.error, /paused: test pause/);
    await request(ctx.url, '/api/budget/providers/kimi/resume', { reason: 'test resume' });

    ctx.app.state.settings.maxConcurrent = 0;
    const queued = await request(ctx.url, '/api/runs', task(ctx, { provider: 'kimi', model: 'kimi-k3[1m]' }));
    assert.equal(queued.status, 202);
    assert.equal((await request(ctx.url, '/api/budget')).body.budget.providers.kimi.reservedUsd, RESERVATION_FOR_0_2);
    const cancelled = await request(ctx.url, `/api/runs/${queued.body.run.id}/cancel`, {});
    assert.equal(cancelled.body.run.budget.status, 'released');
    assert.equal((await request(ctx.url, '/api/budget')).body.budget.providers.kimi.reservedUsd, 0);
  } finally { restore(); await ctx.cleanup(); }
});

test('queued runs keep their pinned commit when the project snapshot is refreshed', async () => {
  const ctx = await setup();
  try {
    ctx.app.state.settings.maxConcurrent = 0;
    const queued = await request(ctx.url, '/api/runs', task(ctx, { provider: 'claude', prompt: '[[scenario:ok]]' }));
    assert.equal(queued.body.run.sourceCommit, ctx.first);
    await writeFile(path.join(ctx.repo, 'second.txt'), 'second\n');
    git(ctx.repo, ['add', '.']); git(ctx.repo, ['commit', '-m', 'second']);
    const second = git(ctx.repo, ['rev-parse', 'HEAD']);
    await writeFile(path.join(ctx.repo, 'dirty.txt'), 'uncommitted\n');

    const again = await request(ctx.url, '/api/projects', { path: ctx.repo });
    assert.equal(again.body.project.commit, ctx.first, 're-registering never moves the snapshot');
    assert.equal(again.body.project.stale, true);
    assert.equal(again.body.project.head, second);

    const refreshed = await request(ctx.url, `/api/projects/${ctx.project.id}/refresh`, { reason: 'test refresh' });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.project.commit, second);
    assert.equal(refreshed.body.snapshot.previousCommit, ctx.first);
    assert.equal(refreshed.body.snapshot.uncommittedPaths, 1);
    assert.match(refreshed.body.snapshot.contains, /NOT included/);
    assert.equal((await request(ctx.url, `/api/projects/${ctx.project.id}/refresh`, { commit: 'zzzz' })).status, 400);

    const pinned = await request(ctx.url, '/api/runs', task(ctx, { provider: 'claude', sourceCommit: ctx.first.slice(0, 10) }));
    assert.equal(pinned.body.run.sourceCommit, ctx.first, 'explicit short commit resolves to the full id');
    assert.equal((await request(ctx.url, '/api/runs', task(ctx, { provider: 'claude', sourceCommit: 'deadbeefdeadbeef' }))).status, 400);

    ctx.app.state.settings.maxConcurrent = 2;
    ctx.app.resumeQueue();
    const run = await finished(ctx, queued.body.run.id);
    assert.equal(run.status, 'completed', run.error);
    assert.equal(git(run.worktreePath, ['rev-parse', 'HEAD']), ctx.first, 'the queued run used its original pinned commit');
    const later = await finished(ctx, (await request(ctx.url, '/api/runs', task(ctx, { provider: 'claude' }))).body.run.id);
    assert.equal(git(later.worktreePath, ['rev-parse', 'HEAD']), second);
  } finally { await ctx.cleanup(); }
});

test('worker brief carries rules and allowed paths; review flags out-of-scope and untracked changes', async () => {
  const ctx = await setup();
  try {
    const run = await finished(ctx, (await request(ctx.url, '/api/runs', task(ctx, {
      provider: 'claude', mode: 'edit', allowedPaths: ['src/'], prompt: '[[scenario:ok]] [[write:src/ok.txt]] [[write:other.txt]]',
    }))).body.run.id);
    assert.equal(run.status, 'completed', run.error);
    assert.deepEqual(run.scope.changedFiles.sort(), ['other.txt', 'src/ok.txt']);
    assert.deepEqual(run.scope.outOfScope, ['other.txt']);
    assert.match(run.diff, /src\/ok\.txt/);
    assert.match(run.diff, /other\.txt/, 'new untracked files appear in the reviewed diff');
    assert.equal((await request(ctx.url, '/api/runs', task(ctx, { mode: 'read', allowedPaths: ['src'] }))).status, 400);
    assert.equal((await request(ctx.url, '/api/runs', task(ctx, { mode: 'edit', provider: 'claude', allowedPaths: ['../escape'] }))).status, 400);
  } finally { await ctx.cleanup(); }
});

test('restart marks active paid work interrupted, keeps its reservation uncertain and never relaunches it', async () => {
  const restore = withEnv(SYNTHETIC_KEYS);
  const ctx = await setup();
  try {
    const created = await request(ctx.url, '/api/runs', task(ctx, { prompt: '[[scenario:slow]]', timeoutSeconds: 120 }));
    const runId = created.body.run.id;
    await waitFor(async () => ctx.app.ledger.entry(created.body.run.budget.entryId)?.dispatchedAt);
    // Simulate a crash: stop the listener and lock without letting the run finish normally.
    const statePath = path.join(ctx.dataDir, 'state.json');
    const crashed = JSON.parse(await readFile(statePath, 'utf8'));
    crashed.runs.find((run) => run.id === runId).status = 'running';
    await ctx.close();
    await writeFile(statePath, JSON.stringify(crashed));
    const ledgerPath = path.join(ctx.dataDir, 'build-budget.json');
    const ledgerData = JSON.parse(await readFile(ledgerPath, 'utf8'));
    const entry = ledgerData.entries.find((e) => e.runId === runId);
    Object.assign(entry, { status: 'reserved', closedAt: null });
    await writeFile(ledgerPath, JSON.stringify(ledgerData));

    const restarted = await setup({ root: ctx.root, dataDir: ctx.dataDir });
    try {
      const run = (await request(restarted.url, `/api/runs/${runId}`)).body.run;
      assert.equal(run.status, 'interrupted');
      assert.match(run.error, /not relaunched/);
      assert.equal(run.budget.status, 'uncertain');
      await sleep(300);
      assert.equal((await request(restarted.url, `/api/runs/${runId}`)).body.run.status, 'interrupted');
      assert.ok((await request(restarted.url, '/api/budget')).body.budget.providers.deepseek.uncertainUsd > 0);
      await assert.rejects(createHarnessServer({ rootDir: ctx.root, dataDir: ctx.dataDir }), /Another Crew Desk server/);
    } finally { await restarted.close(); }
  } finally { restore(); await ctx.cleanup(); }
});

test('isolated working-tree snapshot pins intended changes without touching HEAD, index or files', async () => {
  const ctx = await setup();
  try {
    await writeFile(path.join(ctx.repo, 'README.md'), 'fixture edited\n');
    await writeFile(path.join(ctx.repo, 'new.txt'), 'untracked\n');
    await writeFile(path.join(ctx.repo, '.env.example'), 'EXAMPLE_KEY=\n');
    await writeFile(path.join(ctx.repo, '.env.local'), 'NOT_A_REAL_SECRET=1\n');
    const refused = await request(ctx.url, `/api/projects/${ctx.project.id}/refresh`, { includeWorkingTree: true, reason: 'secret guard' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /possible secret files: \.env\.local/);
    await rm(path.join(ctx.repo, '.env.local'));
    const statusBefore = git(ctx.repo, ['status', '--porcelain']);
    const snap = await request(ctx.url, `/api/projects/${ctx.project.id}/refresh`, { includeWorkingTree: true, reason: 'lead review snapshot' });
    assert.equal(snap.status, 200, JSON.stringify(snap.body));
    assert.equal(snap.body.snapshot.kind, 'working-tree');
    assert.notEqual(snap.body.project.commit, ctx.first);
    assert.equal(git(ctx.repo, ['rev-parse', 'HEAD']), ctx.first, 'HEAD unchanged');
    assert.equal(git(ctx.repo, ['status', '--porcelain']), statusBefore, 'index and working tree unchanged');
    assert.deepEqual(snap.body.snapshot.changedPaths.map((c) => c.path).sort(), ['.env.example', 'README.md', 'new.txt'], 'committed templates are allowed');
    assert.equal(git(ctx.repo, ['show', `${snap.body.project.commit}:new.txt`]), 'untracked');
    assert.equal(git(ctx.repo, ['rev-parse', `refs/crew-snapshots/${snap.body.project.commit}`]), snap.body.project.commit);
    const run = await finished(ctx, (await request(ctx.url, '/api/runs', task(ctx, { provider: 'claude' }))).body.run.id);
    assert.equal(git(run.worktreePath, ['rev-parse', 'HEAD']), snap.body.project.commit);
  } finally { await ctx.cleanup(); }
});

test('balance check stores numbers only and never the credential', async () => {
  const restore = withEnv(SYNTHETIC_KEYS);
  const root = await mkdtemp(path.join(tmpdir(), 'crew-bal-'));
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization });
    if (url.includes('deepseek')) return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '9.50', granted_balance: '0.00', topped_up_balance: '9.50' }] }), { status: 200 });
    return new Response('{}', { status: 401 });
  };
  const pricingFile = path.join(root, 'pricing.json');
  await writeFile(pricingFile, JSON.stringify(PRICING));
  const app = await createHarnessServer({ rootDir: root, dataDir: path.join(root, 'data'), pricingFile, fetchImpl });
  const url = await app.start(0);
  try {
    const ok = await request(url, '/api/budget/providers/deepseek/balance-check', {});
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.body.balance.balances, [{ currency: 'USD', total: 9.5, granted: 0, toppedUp: 9.5 }]);
    assert.equal(seen[0].url, 'https://api.deepseek.com/user/balance');
    assert.equal(seen[0].auth, `Bearer ${SYNTHETIC_KEYS.DEEPSEEK_API_KEY}`);
    const failed = await request(url, '/api/budget/providers/kimi/balance-check', {});
    assert.equal(failed.status, 400);
    assert.match(failed.body.error, /HTTP 401/);
    const ledgerText = await readFile(path.join(root, 'data', 'build-budget.json'), 'utf8');
    assert.ok(!ledgerText.includes(SYNTHETIC_KEYS.DEEPSEEK_API_KEY) && !ledgerText.includes(SYNTHETIC_KEYS.MOONSHOT_API_KEY));
    assert.equal((await request(url, '/api/state')).body.budget.providers.deepseek.baselineBalance.balances[0].total, 9.5);
  } finally { restore(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('fractional reservation policy values pause the lane instead of breaking integer micro-dollars', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'crew-policy-'));
  const pricingFile = path.join(root, 'pricing.json');
  await writeFile(pricingFile, JSON.stringify({ ...PRICING, deepseek: { ...PRICING.deepseek, headroomCalls: 2.5 } }));
  try {
    const ledger = await openBudgetLedger({ file: path.join(root, 'ledger.json'), pricingFile });
    const attempt = await ledger.reserve({ provider: 'deepseek', runId: 'r', model: 'deepseek-flash', targetUsd: 0.1 });
    assert.equal(attempt.ok, false);
    assert.match(attempt.reason, /no valid reservation policy/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a cancel that arrives while dispatch is being persisted prevents the worker from starting', async () => {
  const restore = withEnv(SYNTHETIC_KEYS);
  const ctx = await setup();
  try {
    const marker = path.join(ctx.root, 'spawned.json');
    let runId = null;
    const original = ctx.app.ledger.markDispatched;
    ctx.app.ledger.markDispatched = async (id) => {
      const result = await original(id);
      await request(ctx.url, `/api/runs/${runId}/cancel`, {});
      return result;
    };
    const created = await request(ctx.url, '/api/runs', task(ctx, { prompt: `[[scenario:slow]] [[envdump:${marker}]]` }));
    runId = created.body.run.id;
    const run = await finished(ctx, runId);
    assert.equal(run.status, 'cancelled');
    assert.equal(run.budget.status, 'released', 'no process started, so nothing could be charged');
    await assert.rejects(readFile(marker, 'utf8'), /ENOENT/, 'the worker process never ran');
    ctx.app.ledger.markDispatched = original;
  } finally { restore(); await ctx.cleanup(); }
});
