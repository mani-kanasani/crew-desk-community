// Crew Desk backend.
//
// The worker boundary is intentionally local and explicit: a run gets a
// detached git worktree, a Claude Code child process (or the offline demo
// worker), durable state, and a retained diff. Adapted selectively from the
// Claude CLI runner in the author's Crew Runtime Kit.

import http from 'node:http';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { createUsageTracker, estimateCostUsd } from './usage.mjs';
import { fromMicros, openBudgetLedger, PAID_PROVIDERS, reportedModelsMatch } from './budget.mjs';

const execFileAsync = promisify(execFile);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
// The harness root is one level above `server/`. Keeping this explicit means
// production serving finds dist/ and state stays in .local/,
// rather than accidentally using the folder above it.
const DEFAULT_ROOT = path.resolve(MODULE_DIR, '..');
const DEFAULT_PORT = 4317;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_LOGS = 600;
const MAX_LOG_MESSAGE = 2500;
const MAX_OUTPUT = 120_000;
const MAX_DIFF = 300_000;
const MAX_RUNS = 200;
const DEFAULT_MAX_TURNS = 8;
const DEFAULT_TIMEOUT_SECONDS = 900;
const PROVIDER_DEFS = {
  claude: { id: 'claude', name: 'Claude Code', model: null, billing: 'Claude subscription', endpoint: null },
  kimi: { id: 'kimi', name: 'Kimi (Claude CLI)', model: process.env.KIMI_MODEL?.trim() || 'kimi-k3[1m]', billing: 'Kimi API balance', endpoint: 'https://api.moonshot.ai/anthropic' },
  deepseek: { id: 'deepseek', name: 'DeepSeek (Claude CLI)', model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash', billing: 'DeepSeek API balance', endpoint: 'https://api.deepseek.com/anthropic' },
  demo: { id: 'demo', name: 'Demo rehearsal (local)', model: 'deterministic-demo', billing: 'Local deterministic rehearsal', endpoint: null },
};

const REDACT_PATTERNS = [
  /((?:ANTHROPIC|OPENAI|MOONSHOT|KIMI|DEEPSEEK|GOOGLE|GEMINI)[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*)([^\s,;"']+)/gi,
  /\b(?:sk|key|token|secret|api)[-_][A-Za-z0-9_-]{12,}\b/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
];

function redact(value) {
  let output = String(value ?? '');
  for (const pattern of REDACT_PATTERNS) output = output.replace(pattern, (...args) => pattern.source.includes('\\s*[=:]') ? `${args[1]}[REDACTED]` : '[REDACTED]');
  return output;
}

function truncate(value, max) {
  const text = redact(value);
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}

function now() { return new Date().toISOString(); }

function safeName(value, fallback = 'project') {
  const cleaned = String(value ?? '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return (cleaned || fallback).slice(0, 80);
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function errorBody(res, status, message, details = undefined) {
  json(res, status, details ? { error: message, details } : { error: message });
}

function normalizeHost(host) {
  const value = String(host ?? '').trim().toLowerCase();
  if (value.startsWith('[')) return value.slice(1, value.indexOf(']'));
  return value.split(':')[0];
}

function isAllowedHost(host) {
  const hostname = normalizeHost(host);
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function requestHost(req) { return req.headers.host || ''; }

function authorizeRequest(req, { mutation = false } = {}) {
  if (!isAllowedHost(requestHost(req))) return { ok: false, status: 421, error: 'Host is not allowed' };
  if (mutation) {
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!contentType.startsWith('application/json')) return { ok: false, status: 415, error: 'JSON content type is required' };
    const origin = req.headers.origin;
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (parsed.protocol !== 'http:' || !isAllowedHost(parsed.host) || parsed.host.toLowerCase() !== requestHost(req).toLowerCase()) {
          return { ok: false, status: 403, error: 'Cross-origin mutation rejected' };
        }
      } catch { return { ok: false, status: 403, error: 'Invalid origin' }; }
    }
  }
  return { ok: true };
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        done = true;
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (!done) resolve(raw ? JSON.parse(raw) : {});
    });
    req.on('error', (err) => { if (!done) reject(err); });
  });
}

async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temp, file);
}

async function command(file, args, options = {}) {
  return execFileAsync(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...options });
}

async function git(cwd, args, options = {}) {
  return command('git', ['-C', cwd, ...args], options);
}

async function ensureGitProject(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error('path is required');
  const requested = path.resolve(candidate);
  let stat;
  try { stat = await fs.stat(requested); } catch { throw new Error('path does not exist'); }
  if (!stat.isDirectory()) throw new Error('path must be a directory');
  let top;
  try { top = (await git(requested, ['rev-parse', '--show-toplevel'])).stdout.trim(); } catch { throw new Error('path must be an existing Git repository'); }
  const root = path.resolve(top);
  let commit;
  try { commit = (await git(root, ['rev-parse', '--verify', 'HEAD'])).stdout.trim(); } catch { throw new Error('Git repository must have an initial commit'); }
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error('Git repository has no valid HEAD commit');
  const branch = (await git(root, ['branch', '--show-current']).catch(() => ({ stdout: '' }))).stdout.trim() || null;
  return { path: root, commit, branch };
}

function projectFor(state, projectId) { return state.projects.find((project) => project.id === projectId); }
function runFor(state, runId) { return state.runs.find((run) => run.id === runId); }

function appendLog(run, type, message) {
  run.logs = Array.isArray(run.logs) ? run.logs : [];
  run.logs.push({ at: now(), type, message: truncate(message, MAX_LOG_MESSAGE) });
  if (run.logs.length > MAX_LOGS) run.logs.splice(0, run.logs.length - MAX_LOGS);
}

function makeState() {
  return { version: 1, projects: [], runs: [], settings: { maxConcurrent: 2 } };
}

function publicState(state, providers) {
  return { projects: state.projects, providers, runs: state.runs, settings: state.settings };
}

function resolveClaudeLaunch(config) {
  // A caller-supplied binary is an explicit test/host choice; preserve it so
  // spawn errors are observable instead of silently selecting another CLI.
  if (config.claudeBin) return config.claudeBin;
  const preferred = process.env.CLAUDE_BIN;
  const candidates = [];
  if (preferred) candidates.push(preferred);
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) candidates.push(path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
    candidates.push(path.join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
    candidates.push('claude.exe');
  } else {
    candidates.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude', 'claude');
  }
  const existing = candidates.find((candidate) => path.isAbsolute(candidate) && existsSync(candidate));
  return existing || candidates[candidates.length - 1];
}

// A parent process (including an interactive Claude Code lead session) can
// export provider credentials, host-session channels and OAuth material.
// Workers inherit none of it: names with these prefixes or secret-like words
// are dropped, then the selected provider's own credential is added back.
const STRIPPED_ENV_PREFIX = /^(ANTHROPIC_|CLAUDE|MOONSHOT_|KIMI_|DEEPSEEK_|OPENAI_|GEMINI_|GOOGLE_|VERTEX|AWS_|AZURE_|SUPABASE_|RESEND_|GITHUB_|GH_|NPM_|MCP_)/i;
const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|COOKIE)/i;
const KEPT_ENV = new Set(['CLAUDE_CODE_GIT_BASH_PATH']);

function baseChildEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    if (!KEPT_ENV.has(key) && (STRIPPED_ENV_PREFIX.test(key) || SECRET_ENV_NAME.test(key))) continue;
    env[key] = value;
  }
  // Claude Code on Windows only offers its Bash tool when it can find Git Bash.
  if (process.platform === 'win32' && !env.CLAUDE_CODE_GIT_BASH_PATH) {
    const gitBash = findGitBash();
    if (gitBash) env.CLAUDE_CODE_GIT_BASH_PATH = gitBash;
  }
  return env;
}

let gitBashCache;
function findGitBash() {
  if (gitBashCache !== undefined) return gitBashCache;
  const candidates = [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')];
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    if (existsSync(path.join(dir, 'git.exe'))) candidates.push(path.join(dir, '..', 'bin', 'bash.exe'), path.join(dir, '..', 'usr', 'bin', 'bash.exe'), path.join(dir, 'bash.exe'));
    if (/\\usr\\bin$/i.test(dir) || /\\git\\bin$/i.test(dir)) candidates.push(path.join(dir, 'bash.exe'));
  }
  if (process.env.HERMES_GIT_BASH_PATH) candidates.push(process.env.HERMES_GIT_BASH_PATH);
  gitBashCache = candidates.map((candidate) => path.resolve(candidate)).find((candidate) => existsSync(candidate)) ?? null;
  return gitBashCache;
}

function providerLaunch(provider, model, config = {}) {
  const env = baseChildEnv();
  const selectedModel = model || PROVIDER_DEFS[provider]?.model;
  if (provider === 'claude' && process.env.CLAUDE_CODE_EFFORT_LEVEL) env.CLAUDE_CODE_EFFORT_LEVEL = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  if (provider === 'kimi') {
    const token = process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY;
    if (!token) return { error: 'Kimi provider is unavailable: MOONSHOT_API_KEY or KIMI_API_KEY is missing' };
    const effort = process.env.KIMI_EFFORT?.trim() || 'max';
    if (!['low', 'high', 'max'].includes(effort)) return { error: 'KIMI_EFFORT must be low, high, or max' };
    env.ANTHROPIC_AUTH_TOKEN = token;
    env.ANTHROPIC_BASE_URL = PROVIDER_DEFS.kimi.endpoint;
    env.CLAUDE_CODE_EFFORT_LEVEL = effort;
  } else if (provider === 'deepseek') {
    const token = process.env.DEEPSEEK_API_KEY;
    if (!token) return { error: 'DeepSeek provider is unavailable: DEEPSEEK_API_KEY is missing' };
    env.ANTHROPIC_AUTH_TOKEN = token;
    env.ANTHROPIC_BASE_URL = PROVIDER_DEFS.deepseek.endpoint;
  }
  if (provider !== 'claude') env.ANTHROPIC_MODEL = selectedModel;
  if (provider !== 'claude') {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = selectedModel;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = selectedModel;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = selectedModel;
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = selectedModel;
    env.CLAUDE_CODE_SUBAGENT_MODEL = selectedModel;
    env.CLAUDE_CODE_DEFAULT_MODEL = selectedModel;
    // Paid lanes: no background/non-essential traffic, and a per-response
    // output cap so one call's worst case is bounded for the reservation.
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    if (Number.isInteger(config.maxOutputTokens) && config.maxOutputTokens > 0) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(config.maxOutputTokens);
    // Compact well before the provider's 1M window so per-call context stays
    // near the reservation's context bound (a practical limit, not a provider cap).
    if (Number.isInteger(config.autoCompactWindowTokens) && config.autoCompactWindowTokens > 0) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(config.autoCompactWindowTokens);
  }
  // The session-title call is not covered by the non-essential traffic switch.
  env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = '1';
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--setting-sources', '', '--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--max-turns', String(config.maxTurns ?? DEFAULT_MAX_TURNS)];
  // Paid lanes stream message_delta usage so the in-flight guard sees real output tokens.
  if (provider !== 'claude') args.push('--include-partial-messages');
  // Claude subscription runs use the CLI default unless a model (e.g. sonnet, haiku) is requested.
  if (provider !== 'claude' || model) args.push('--model', selectedModel);
  // The CLI's --max-budget-usd prices tokens with its own Anthropic rate table,
  // which is not the DeepSeek/Kimi rate. Paid lanes use the ledger's
  // provider-priced in-flight guard instead; the flag remains for Claude runs.
  if (provider === 'claude' && config.budgetUsd != null && Number.isFinite(config.budgetUsd) && config.budgetUsd > 0) args.push('--max-budget-usd', String(config.budgetUsd));
  // On Windows the CLI's shell tool may be exposed as PowerShell rather than Bash;
  // request both so edit workers can run the checks their brief requires.
  const shellTools = process.platform === 'win32' ? 'Bash,PowerShell' : 'Bash';
  const tools = config.mode === 'read' ? 'Read,Glob,Grep' : `Read,Write,Edit,Glob,Grep,${shellTools}`;
  args.push('--tools', tools, '--allowedTools', tools);
  // Tests may supply an explicit command (for example node + a fixture script).
  if (config.claudeCommand?.bin) return { bin: config.claudeCommand.bin, args: [...(config.claudeCommand.args ?? []), ...args], env, selectedModel };
  return { bin: resolveClaudeLaunch(config), args, env, selectedModel };
}

/** Standard leaf-worker preamble. Safe mode skips CLAUDE.md, so rules travel with the brief. */
export function workerBrief(run, projectName) {
  const scope = run.mode === 'read'
    ? 'Read-only review: do not modify any files.'
    : run.allowedPaths?.length
      ? `Edit only these repository-relative paths: ${run.allowedPaths.join(', ')}. Changes anywhere else are rejected in review.`
      : 'Edit mode: change only what the brief requires.';
  return [
    'You are a bounded Crew Desk worker (a leaf task).',
    `Repository: ${projectName} at commit ${run.sourceCommit}, checked out in an isolated Git worktree (your current directory).`,
    'Project CLAUDE.md files, skills and hooks are not loaded; the brief below is your complete instruction set.',
    scope,
    'Never read, print or copy secrets (.env files, keys, tokens). Never call paid AI or provider APIs, send email or messages, deploy, push, or change global settings.',
    'Do not delegate, start other agents, or use MCP.',
    `Maximum turns: ${run.maxTurns}. Stop when the acceptance criteria are met.`,
    'Finish with a concise report: summary, changed files, checks run with exact results, unresolved issues.',
  ].join('\n');
}

function providerStatus(id, config) {
  const def = PROVIDER_DEFS[id];
  if (id === 'demo') return { ...def, available: true, status: 'ready', detail: 'Offline synthetic project and deterministic edit; no AI call.' };
  const bin = resolveClaudeLaunch(config);
  const installed = path.isAbsolute(bin) ? existsSync(bin) : true;
  if (!installed) return { ...def, available: false, status: 'unavailable', detail: 'Claude CLI is not installed.' };
  if (id === 'kimi' && !(process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY)) return { ...def, available: false, status: 'unconfigured', detail: 'Set MOONSHOT_API_KEY or KIMI_API_KEY for the child process.' };
  if (id === 'deepseek' && !process.env.DEEPSEEK_API_KEY) return { ...def, available: false, status: 'unconfigured', detail: 'Set DEEPSEEK_API_KEY for the child process.' };
  return { ...def, available: true, status: id === 'claude' ? 'installed' : 'configured', detail: id === 'claude' ? 'Uses the installed Claude CLI subscription; live auth is checked only when a run starts.' : `Uses Claude CLI with ${def.endpoint}.` };
}

export function readableEventContent(content) {
  if (typeof content === 'string') return content;
  if (!content) return '';
  if (Array.isArray(content)) return content.map(readableEventContent).filter(Boolean).join('\n');
  if (content.type === 'thinking' || content.type === 'redacted_thinking') return '';
  if (content.type === 'tool_use') return `Using ${content.name || 'tool'}${content.input?.file_path ? `: ${content.input.file_path}` : ''}`;
  if (content.type === 'tool_result') return `${content.is_error ? 'Tool error' : 'Tool finished'}${content.content ? `: ${readableEventContent(content.content)}` : ''}`;
  if (content.type === 'image') return '[Image output]';
  if (typeof content.text === 'string') return content.text;
  return '';
}

function parseStreamLine(line, run, collector, tracker, onUsage) {
  if (!line.trim()) return;
  let event;
  try { event = JSON.parse(line); } catch { appendLog(run, 'stdout', line); return; }
  if (tracker?.observe(event) && onUsage) onUsage(tracker.snapshot());
  // Record what the worker session actually received (tools can differ by platform).
  if (event.type === 'system' && event.subtype === 'init') {
    appendLog(run, 'system', `Worker session: model ${event.model ?? 'unknown'}; tools ${Array.isArray(event.tools) ? event.tools.join(', ') : 'not reported'}`);
    if (Array.isArray(event.tools)) run.sessionTools = event.tools;
  }
  const type = event.type || 'event';
  if (type === 'assistant') collector.turns += 1;
  if (type === 'result') {
    collector.result = typeof event.result === 'string' ? event.result : collector.result;
    collector.usage = event.usage || event.usage_metadata || collector.usage;
    collector.cost = event.total_cost_usd ?? event.cost_usd ?? collector.cost;
    if (event.num_turns != null) collector.turns = Number(event.num_turns) || collector.turns;
    if (event.is_error) {
      // Name the reason (for example error_max_turns) so a stopped worker is not mistaken for a crash.
      const reason = event.subtype === 'error_max_turns' ? `stopped at the turn limit (${event.num_turns ?? '?'} turns); the diff may be incomplete`
        : event.subtype && event.subtype !== 'success' ? `Claude CLI error: ${event.subtype}` : null;
      collector.error = event.result || reason || 'Claude CLI returned an error';
    }
  } else if (type === 'assistant' || type === 'user' || type === 'system') {
    const text = readableEventContent(event.message?.content ?? event.content ?? event.message);
    if (text) appendLog(run, type, text);
  } else if (event.error) appendLog(run, 'error', event.error.message || event.error);
  else if (event.message && typeof event.message === 'string') appendLog(run, type, event.message);
}

async function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(Math.trunc(child.pid)), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false });
      killer.once('close', resolve);
      killer.once('error', resolve);
    });
  } else {
    try { child.kill('SIGTERM'); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!child.killed) { try { child.kill('SIGKILL'); } catch {} }
  }
}

async function runClaudeProcess({ run, launch, prompt, cwd, timeoutSeconds, onChild, onUsage }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tracker = createUsageTracker();
    let child;
    try {
      child = spawn(launch.bin, launch.args, { cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    } catch (err) { resolve({ ok: false, code: 'spawnerror', error: err.message, usage: tracker.snapshot() }); return; }
    onChild(child);
    const collector = { result: '', usage: null, cost: null, turns: 0, error: null };
    let stdoutBuffer = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let spawned = false;
    child.once('spawn', () => { spawned = true; });
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ...result, usage: tracker.snapshot(), turns: collector.turns }); };
    const timer = setTimeout(async () => { timedOut = true; await killProcessTree(child); }, Math.max(1, timeoutSeconds) * 1000);
    const usageChanged = (snapshot) => {
      if (!onUsage || run._budgetStop) return;
      if (onUsage(snapshot) === 'stop') { run._budgetStop = true; void killProcessTree(child); }
    };
    child.stdout?.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      let newline;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline); stdoutBuffer = stdoutBuffer.slice(newline + 1);
        parseStreamLine(line, run, collector, tracker, usageChanged);
      }
    });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); appendLog(run, 'stderr', chunk.toString('utf8')); });
    child.on('error', (err) => finish({ ok: false, code: spawned ? 'cli_failure' : 'spawnerror', error: err.message }));
    child.on('close', (code, signal) => {
      if (stdoutBuffer) parseStreamLine(stdoutBuffer, run, collector, tracker, usageChanged);
      if (run._budgetStop) return finish({ ok: false, code: 'budget_stop', error: 'Stopped by Crew Desk’s paid-lane guard (budget target or context bound reached; see Activity). Any in-flight call may still be charged.' });
      if (timedOut) return finish({ ok: false, code: 'timeout', error: `Run timed out after ${timeoutSeconds} seconds` });
      if (run._cancelRequested) return finish({ ok: false, code: 'cancelled', error: 'Run cancelled' });
      if (collector.error) return finish({ ok: false, code: 'cli_failure', error: truncate(collector.error, 2000) });
      if (code !== 0) return finish({ ok: false, code: 'cli_failure', error: truncate(stderr || `Claude CLI exited with ${code ?? signal ?? 'unknown status'}`, 2000) });
      finish({ ok: true, output: collector.result || truncate(stdoutBuffer, MAX_OUTPUT), cost: collector.cost, durationMs: Date.now() - started });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(prompt);
  });
}

async function changedPaths(worktree) {
  if (!worktree) return [];
  try {
    const status = (await git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout;
    const files = [];
    const entries = status.split('\0');
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.length < 4) continue;
      files.push(entry.slice(3).replace(/\\/g, '/'));
      if (entry[0] === 'R' || entry[0] === 'C') index += 1; // skip the rename source
    }
    return files;
  } catch { return []; }
}

export function outOfScope(files, run) {
  if (run.mode === 'read') return files;
  if (!run.allowedPaths?.length) return [];
  return files.filter((file) => !run.allowedPaths.some((allowed) => {
    const prefix = allowed.replace(/\/+$/, '');
    if (file === prefix || file.startsWith(`${prefix}/`)) return true;
    return /[*?]/.test(prefix) && globPattern(prefix).test(file);
  }));
}

// Allowed paths may be globs: `*` and `?` stay inside one folder, a whole `**` segment spans any depth.
// Brackets, parentheses and braces are literal, so Next.js folders like app/[slug] and app/(group) match as written.
function globPattern(glob) {
  let source = '';
  for (let index = 0; index < glob.length;) {
    const wholeSegment = glob.startsWith('**', index) && (index === 0 || glob[index - 1] === '/');
    if (wholeSegment && index + 2 === glob.length) { source += '.*'; index += 2; }
    else if (wholeSegment && glob[index + 2] === '/') { source += '(?:.*/)?'; index += 3; }
    else if (glob[index] === '*') { source += '[^/]*'; index += glob[index + 1] === '*' ? 2 : 1; }
    else if (glob[index] === '?') { source += '[^/]'; index += 1; }
    else { source += glob[index].replace(/[\\^$.|+()[\]{}]/, '\\$&'); index += 1; }
  }
  return new RegExp(`^${source}$`);
}

function normalizeAllowedPaths(value) {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > 50) throw new Error('allowedPaths must be an array of at most 50 repository-relative paths');
  return value.map((item) => {
    if (typeof item !== 'string' || !item.trim()) throw new Error('allowedPaths entries must be non-empty strings');
    const normalized = item.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized) || normalized.split('/').includes('..')) throw new Error(`allowedPaths entry must be repository-relative: ${item}`);
    return normalized.slice(0, 300);
  });
}

const SECRET_PATH = /(^|\/)(\.env(\.[^/]*)?|[^/]*\.(pem|key|p12|pfx)|[^/]*(secret|credential)[^/]*)$/i;
// Conventional committed templates carry variable names, not values.
const SAFE_TEMPLATE_PATH = /(^|\/)\.env\.(example|sample|template)$/i;

/**
 * Build a commit object from the current working tree (tracked changes plus
 * untracked, non-ignored files) through a temporary index. HEAD, the branch,
 * the real index and the files on disk are not modified. The commit is kept
 * reachable under refs/crew-snapshots/ so it is not garbage-collected.
 */
async function snapshotWorkingTree(repo, reason) {
  const tempIndex = path.join(tmpdir(), `crew-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
  try {
    const head = (await git(repo, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
    await git(repo, ['read-tree', 'HEAD'], { env });
    await git(repo, ['add', '-A', '--', '.'], { env });
    const changes = (await git(repo, ['diff', '--cached', '--name-status', '--no-renames', 'HEAD'], { env })).stdout.split('\n').filter(Boolean)
      .map((line) => { const [status, ...rest] = line.split('\t'); return { status, path: rest.join('\t').replace(/\\/g, '/') }; });
    const risky = changes.filter((change) => change.status !== 'D' && SECRET_PATH.test(change.path) && !SAFE_TEMPLATE_PATH.test(change.path));
    if (risky.length) throw new Error(`Refusing to snapshot possible secret files: ${risky.map((change) => change.path).join(', ')}. Ignore or remove them first.`);
    const tree = (await git(repo, ['write-tree'], { env })).stdout.trim();
    const commit = (await git(repo, ['commit-tree', tree, '-p', head, '-m', `Crew Desk working-tree snapshot: ${reason}`])).stdout.trim();
    await git(repo, ['update-ref', `refs/crew-snapshots/${commit}`, commit]);
    return { commit, head, changes };
  } finally { await fs.rm(tempIndex, { force: true }); }
}

async function resolveCommit(repo, candidate) {
  if (typeof candidate !== 'string' || !/^[0-9a-f]{7,40}$/i.test(candidate.trim())) throw new Error('sourceCommit must be a 7-40 character hexadecimal commit id');
  try { return (await git(repo, ['rev-parse', '--verify', '--quiet', `${candidate.trim()}^{commit}`])).stdout.trim(); } catch { throw new Error(`sourceCommit ${candidate} is not a commit in ${repo}`); }
}

async function diffForWorktree(worktree) {
  if (!worktree) return '';
  try {
    const status = (await git(worktree, ['status', '--porcelain=v1', '-z'])).stdout;
    const untracked = [];
    for (const entry of status.split('\0')) if (entry.startsWith('?? ')) untracked.push(entry.slice(3));
    if (untracked.length) await git(worktree, ['add', '-N', '--', ...untracked]);
    return truncate((await git(worktree, ['diff', '--no-ext-diff', '--binary', 'HEAD', '--'])).stdout, MAX_DIFF);
  } catch (err) { return `Unable to collect diff: ${redact(err.message)}`; }
}

async function createWorktree(project, target, commit) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await git(project.path, ['worktree', 'add', '--detach', target, commit]);
}

// One server per data directory: the budget ledger's atomic admission relies
// on a single writer. A stale lock from a dead process is replaced.
const LOCKED_DATA_DIRS = new Set();
async function acquireDataLock(dataDir) {
  const lockFile = path.join(dataDir, 'server.lock');
  await fs.mkdir(dataDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, at: now() }), { flag: 'wx' });
      LOCKED_DATA_DIRS.add(lockFile);
      return async () => { LOCKED_DATA_DIRS.delete(lockFile); await fs.rm(lockFile, { force: true }); };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let holder = null;
      try { holder = JSON.parse(await fs.readFile(lockFile, 'utf8')); } catch {}
      let alive = false;
      if (holder?.pid === process.pid) alive = LOCKED_DATA_DIRS.has(lockFile);
      else if (holder?.pid) { try { process.kill(holder.pid, 0); alive = true; } catch (probe) { alive = probe.code === 'EPERM'; } }
      if (alive) throw new Error(`Another Crew Desk server (pid ${holder.pid}) is using ${dataDir}. Stop it before starting another.`);
      await fs.rm(lockFile, { force: true });
    }
  }
  throw new Error(`Could not acquire the Crew Desk data lock in ${dataDir}`);
}

const decimal = (value) => { const n = Number(value); return value != null && value !== '' && Number.isFinite(n) ? n : null; };
// Documented account-balance endpoints; responses are reduced to numbers.
const BALANCE_ENDPOINTS = {
  deepseek: {
    url: 'https://api.deepseek.com/user/balance',
    key: () => process.env.DEEPSEEK_API_KEY,
    parse: (body) => Array.isArray(body.balance_infos) ? {
      isAvailable: body.is_available === true,
      balances: body.balance_infos.map((info) => ({ currency: String(info.currency ?? '').slice(0, 8), total: decimal(info.total_balance), granted: decimal(info.granted_balance), toppedUp: decimal(info.topped_up_balance) })),
    } : null,
  },
  kimi: {
    url: 'https://api.moonshot.ai/v1/users/me/balance',
    key: () => process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY,
    parse: (body) => body.data ? { balances: [{ currency: 'USD', total: decimal(body.data.available_balance), voucher: decimal(body.data.voucher_balance), cash: decimal(body.data.cash_balance) }] } : null,
  },
};

/** Compact ledger view stored on a run for the dashboard and queue client. */
function budgetView(entry) {
  if (!entry) return undefined;
  return {
    entryId: entry.id, provider: entry.provider, status: entry.status,
    targetUsd: fromMicros(entry.targetMicros), reservedUsd: fromMicros(entry.reservedMicros),
    estimateUsd: fromMicros(entry.estimateMicros), settledUsd: fromMicros(entry.settledMicros),
    basis: entry.basis, reason: entry.history.at(-1)?.reason ?? null, dispatchedAt: entry.dispatchedAt,
    priceCheckedAt: entry.pricing?.checkedAt ?? null, reconciliation: entry.reconciliation ? { source: entry.reconciliation.source, at: entry.reconciliation.at } : null,
  };
}

/** Usage record stored on a run: categories, per model, completeness and provenance. */
function runUsageRecord(snapshot, run, pricing, estimate) {
  if (!snapshot) return undefined;
  const requested = run.model ?? null;
  const reported = snapshot.perModel ? Object.keys(snapshot.perModel) : snapshot.observedModels;
  const modelsMatch = PAID_PROVIDERS.includes(run.provider) ? reportedModelsMatch(pricing, run.provider, requested, reported) : null;
  return {
    source: snapshot.source,
    completeness: snapshot.completeness,
    missingCategories: snapshot.missingCategories,
    totals: snapshot.totals,
    perModel: snapshot.perModel,
    requestedModel: requested,
    reportedModels: reported,
    sessionModel: snapshot.sessionModel,
    modelsMatch,
    apiMessages: snapshot.apiMessages,
    // What the in-flight guard saw, kept beside the final totals so guard accuracy can be checked.
    inFlightTotals: snapshot.inFlight,
    maxCallContextTokens: snapshot.maxCallContextTokens,
    numTurns: snapshot.result?.numTurns ?? null,
    resultSubtype: snapshot.result?.subtype ?? null,
    cliReportedCostUsd: snapshot.result?.cliTotalCostUsd ?? null,
    cliCostNote: 'Claude CLI total_cost_usd uses its own Anthropic rate table: not a bill, and not the DeepSeek/Kimi rate.',
    ...(estimate ? { providerEstimateUsd: estimate.usd, providerEstimateComplete: estimate.complete, providerEstimateBasis: 'CLI-reported tokens × provider-published rates in server/provider-pricing.json (estimate, not billing)' } : {}),
    // Legacy summary fields (older UI/state readers); null means not reported.
    inputTokens: snapshot.totals.inputTokens,
    outputTokens: snapshot.totals.outputTokens,
  };
}

async function ensureDemoProject(dataDir) {
  const projectPath = path.join(dataDir, 'demo-project');
  try { await git(projectPath, ['rev-parse', '--verify', 'HEAD']); return await ensureGitProject(projectPath); } catch {}
  await fs.rm(projectPath, { recursive: true, force: true });
  await fs.mkdir(path.join(projectPath, 'test'), { recursive: true });
  await fs.writeFile(path.join(projectPath, 'math.mjs'), 'export function add(a, b) { return a + b; }\n', 'utf8');
  await fs.writeFile(path.join(projectPath, 'test', 'math.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../math.mjs';\n\ntest('adds two numbers', () => assert.equal(add(2, 3), 5));\n", 'utf8');
  await git(projectPath, ['init', '-b', 'main']);
  await git(projectPath, ['config', 'user.email', 'crew-desk-demo@localhost']);
  await git(projectPath, ['config', 'user.name', 'Crew Desk Demo']);
  await git(projectPath, ['add', '.']);
  await git(projectPath, ['commit', '-m', 'Create the Crew Desk demo project']);
  return await ensureGitProject(projectPath);
}

export async function createHarnessServer(options = {}) {
  const rootDir = path.resolve(options.rootDir || DEFAULT_ROOT);
  const dataDir = path.resolve(options.dataDir || path.join(rootDir, '.local'));
  const stateFile = path.join(dataDir, 'state.json');
  const config = { ...options, rootDir, dataDir, stateFile, worktreesDir: path.join(dataDir, 'worktrees') };
  const releaseLock = options.lock === false ? async () => {} : await acquireDataLock(dataDir);
  let ledger;
  try {
    ledger = await openBudgetLedger({
      file: options.ledgerFile || path.join(dataDir, 'build-budget.json'),
      pricingFile: options.pricingFile || path.join(rootDir, 'server', 'provider-pricing.json'),
    });
  } catch (err) { await releaseLock(); throw err; }
  let state = makeState();
  try { state = { ...makeState(), ...JSON.parse(await fs.readFile(stateFile, 'utf8')) }; } catch {}
  state.projects = Array.isArray(state.projects) ? state.projects : [];
  state.runs = Array.isArray(state.runs) ? state.runs : [];
  state.settings = { maxConcurrent: 2, ...(state.settings || {}) };
  let changed = false;
  for (const run of state.runs) {
    if (run.status === 'queued' || run.status === 'running') {
      run.status = 'interrupted'; run.finishedAt = now(); run.error = 'Server restarted before this run completed. It was not relaunched.'; delete run._cancelRequested; delete run._budgetStop; appendLog(run, 'system', run.error); changed = true;
    }
  }
  // Reservations of interrupted paid runs: undispatched ones are released;
  // dispatched ones stay uncertain (and keep their reservation) until reconciled.
  if (await ledger.recoverAfterRestart()) changed = true;
  for (const run of state.runs) {
    if (!run.budget?.entryId) continue;
    const entry = ledger.entry(run.budget.entryId);
    if (entry && entry.status !== run.budget.status) { run.budget = budgetView(entry); changed = true; }
  }
  if (changed) await atomicWrite(stateFile, state);
  let writeQueue = Promise.resolve();
  const persist = () => { writeQueue = writeQueue.then(() => atomicWrite(stateFile, state)); return writeQueue; };
  const activeChildren = new Map();
  const finishing = new Set();
  let active = 0;
  const queue = [];

  function providers() { return Object.keys(PROVIDER_DEFS).map((id) => providerStatus(id, config)); }
  function snapshotRun(run) { const copy = JSON.parse(JSON.stringify(run)); delete copy._cancelRequested; delete copy._budgetStop; delete copy._dispatched; return copy; }

  async function finishRun(run, outcome) {
    // A second call (execute's catch after a failed final persist) keeps the
    // first outcome and only retries persistence.
    if (finishing.has(run.id)) { await persist(); return; }
    finishing.add(run.id);
    const dispatched = Boolean(run._dispatched);
    if (run.status === 'cancelled' || run.status === 'interrupted') { delete run._cancelRequested; return; }
    // Attach usage, diff, scope and ledger results before publishing the
    // terminal status, so no reader sees a finished run with stale accounting.
    const finalStatus = run._cancelRequested || outcome.code === 'cancelled' ? 'cancelled' : outcome.ok ? 'completed' : 'failed';
    if (outcome.error) run.error = truncate(outcome.error, 2500);
    if (outcome.output) run.result = truncate(outcome.output, MAX_OUTPUT);
    const entry = run.budget?.entryId ? ledger.entry(run.budget.entryId) : null;
    const estimate = entry && outcome.usage ? estimateCostUsd(outcome.usage.totals, entry.pricing) : null;
    if (outcome.usage) run.usage = runUsageRecord(outcome.usage, run, ledger.pricing, estimate);
    run.diff = await diffForWorktree(run.worktreePath);
    if (run.worktreePath) {
      const files = await changedPaths(run.worktreePath);
      run.scope = { allowedPaths: run.allowedPaths ?? null, changedFiles: files, outOfScope: outOfScope(files, run) };
      if (run.scope.outOfScope.length) appendLog(run, 'system', `Scope check: ${run.scope.outOfScope.length} changed path(s) outside the allowed paths: ${run.scope.outOfScope.slice(0, 20).join(', ')}`);
    }
    if (entry) {
      const closed = await ledger.close(entry.id, {
        neverStarted: !dispatched || outcome.code === 'spawnerror' || outcome.code === 'provider_unavailable',
        usage: outcome.usage ?? null,
        outcome: { code: outcome.code ?? (outcome.ok ? 'ok' : 'failed'), status: finalStatus },
        modelsMatch: run.usage?.modelsMatch ?? null,
      });
      if (closed) { run.budget = budgetView(closed); appendLog(run, 'budget', `Ledger ${closed.status}: ${closed.history.at(-1)?.reason ?? ''}`); }
    }
    delete run._cancelRequested; delete run._budgetStop; delete run._dispatched;
    run.finishedAt = now();
    run.status = finalStatus;
    await persist();
  }

  async function runDemo(run, project, worktree) {
    appendLog(run, 'demo', 'Starting deterministic local rehearsal; no AI provider call.');
    const modulePath = path.join(worktree, 'math.mjs');
    await fs.writeFile(modulePath, 'export function add(a, b) { return a + b; }\nexport function multiply(a, b) { return a * b; }\n', 'utf8');
    appendLog(run, 'demo', 'Edited math.mjs in the isolated worktree.');
    const testResult = await command(process.execPath, ['--test'], { cwd: worktree, timeout: run.timeoutSeconds * 1000 });
    appendLog(run, 'test', truncate(testResult.stdout || 'node --test passed', 5000));
    return { ok: true, output: 'Demo rehearsal completed: edited math.mjs and node --test passed.', usage: undefined };
  }

  async function execute(run) {
    const project = projectFor(state, run.projectId);
    if (!project) { run.status = 'failed'; run.error = 'Project no longer exists'; run.finishedAt = now(); appendLog(run, 'error', run.error); await persist(); return; }
    run.status = 'running'; run.startedAt = now(); appendLog(run, 'system', `Starting ${run.provider} run in an isolated Git worktree.`); await persist();
    const worktree = path.join(config.worktreesDir, `${run.id}-${safeName(run.title, 'run')}`);
    run.worktreePath = worktree;
    run.branch = project.branch || undefined;
    // Runs created before per-run pinning fall back to the project snapshot.
    const commit = run.sourceCommit || project.commit;
    try {
      await createWorktree(project, worktree, commit);
      appendLog(run, 'git', `Created worktree from pinned commit ${commit.slice(0, 12)}.`); await persist();
      let outcome;
      if (run.provider === 'demo') outcome = await runDemo(run, project, worktree);
      else {
        const entry = run.budget?.entryId ? ledger.entry(run.budget.entryId) : null;
        const launch = providerLaunch(run.provider, run.model, { ...run, claudeBin: config.claudeBin, claudeCommand: config.claudeCommand, maxOutputTokens: entry?.maxOutputTokensPerCall, autoCompactWindowTokens: entry?.autoCompactWindowTokens ?? undefined });
        if (launch.error) outcome = { ok: false, code: 'provider_unavailable', error: launch.error };
        else if (run._cancelRequested) outcome = { ok: false, code: 'cancelled', error: 'Run cancelled before the provider started' };
        else if (entry) {
          // Persist dispatch before spawning: from here a charge is possible.
          await ledger.markDispatched(entry.id);
          run.budget = budgetView(ledger.entry(entry.id));
        }
        // A cancel that arrived while dispatch was being persisted wins: no process starts
        // (_dispatched stays unset, so the reservation is released as never started).
        if (!outcome && run._cancelRequested) outcome = { ok: false, code: 'cancelled', error: 'Run cancelled before the provider started' };
        if (!outcome) {
          const prompt = `${workerBrief(run, project.name)}\n\n--- Brief ---\n${run.prompt}`;
          run._dispatched = true;
          const onUsage = entry ? (snapshot) => {
            const live = estimateCostUsd(snapshot.totals, entry.pricing);
            run.liveEstimateUsd = live.usd;
            if (live.usd != null && live.usd >= fromMicros(entry.targetMicros)) {
              appendLog(run, 'budget', `Estimated spend ${live.usd} USD reached the ${fromMicros(entry.targetMicros)} USD task target; stopping the worker.`);
              return 'stop';
            }
            if (entry.contextBoundTokens && snapshot.maxCallContextTokens > entry.contextBoundTokens) {
              appendLog(run, 'budget', `A call used ${snapshot.maxCallContextTokens} context tokens, above the reservation bound of ${entry.contextBoundTokens}; stopping the worker.`);
              return 'stop';
            }
            return undefined;
          } : undefined;
          // A cancel between the checks above and spawn is enforced as soon as the child exists.
          const onChild = (child) => { activeChildren.set(run.id, child); if (run._cancelRequested) void killProcessTree(child); };
          outcome = await runClaudeProcess({ run, launch, prompt, cwd: worktree, timeoutSeconds: run.timeoutSeconds, onChild, onUsage });
        }
      }
      await finishRun(run, outcome);
    } catch (err) {
      await finishRun(run, { ok: false, code: 'failed', error: err.message });
    } finally { activeChildren.delete(run.id); }
  }

  function pump() {
    while (active < state.settings.maxConcurrent && queue.length) {
      const runId = queue.shift();
      const run = runFor(state, runId);
      if (!run || run.status !== 'queued') continue;
      active += 1;
      void execute(run).finally(() => { active -= 1; pump(); });
    }
  }

  async function registerProject(body) {
    const info = await ensureGitProject(body.path);
    const existing = state.projects.find((project) => project.path === info.path);
    // Re-registering never moves the snapshot; it reports whether HEAD moved.
    if (existing) return { ...existing, head: info.commit, stale: info.commit !== existing.commit };
    const project = { id: `project_${randomUUID()}`, name: safeName(body.name, path.basename(info.path)), path: info.path, commit: info.commit, branch: info.branch, snapshots: [{ commit: info.commit, at: now(), reason: 'registered', branch: info.branch }] };
    state.projects.push(project); await persist(); return project;
  }

  /**
   * Read a provider account balance (documented, non-generating endpoints) and
   * store only the numbers. Used for a baseline and to reconcile paid runs; it
   * covers the whole provider account, so unrelated activity must be excluded.
   */
  async function checkProviderBalance(provider) {
    const endpoint = BALANCE_ENDPOINTS[provider];
    if (!endpoint) throw new Error('Balance checks are available for deepseek and kimi only');
    const key = endpoint.key();
    if (!key) throw new Error(`${provider} key is not configured`);
    const fetchImpl = options.fetchImpl || fetch;
    let response;
    try {
      response = await fetchImpl(endpoint.url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    } catch (err) {
      await ledger.recordBalance(provider, { kind: 'api', source: endpoint.url, ok: false, error: `network error: ${redact(err.message).slice(0, 200)}` });
      throw new Error(`${provider} balance check failed: network error`);
    }
    if (!response.ok) {
      await ledger.recordBalance(provider, { kind: 'api', source: endpoint.url, ok: false, httpStatus: response.status });
      throw new Error(`${provider} balance check failed with HTTP ${response.status}`);
    }
    const body = await response.json().catch(() => null);
    const parsed = body ? endpoint.parse(body) : null;
    if (!parsed) throw new Error(`${provider} balance response had an unexpected format`);
    return ledger.recordBalance(provider, { kind: 'api', source: endpoint.url, ok: true, ...parsed });
  }

  /** Explicitly move a project's snapshot to HEAD or a named commit. Queued runs keep their pinned commit. */
  async function refreshProject(projectId, body) {
    const project = projectFor(state, projectId);
    if (!project) { const err = new Error('Project not found'); err.status = 404; throw err; }
    const info = await ensureGitProject(project.path);
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 300) : 'explicit refresh';
    if (body.commit && body.includeWorkingTree) throw new Error('Choose either commit or includeWorkingTree, not both');
    const isolated = body.includeWorkingTree === true ? await snapshotWorkingTree(project.path, reason) : null;
    const commit = isolated ? isolated.commit : body.commit ? await resolveCommit(project.path, body.commit) : info.commit;
    const pending = (await git(project.path, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout.split('\n').filter(Boolean);
    const snapshot = {
      commit, previousCommit: project.commit, at: now(), branch: info.branch, head: info.commit, reason,
      uncommittedPaths: pending.length,
      contains: isolated
        ? `Isolated working-tree snapshot ${commit.slice(0, 12)}: HEAD ${info.commit.slice(0, 12)} plus ${isolated.changes.length} changed path(s). Branch, index and files were not modified; ignored files are excluded.`
        : pending.length ? `Commit ${commit.slice(0, 12)} only. ${pending.length} uncommitted or untracked path(s) in the working tree are NOT included.` : `Commit ${commit.slice(0, 12)}; working tree clean.`,
      ...(isolated ? { kind: 'working-tree', changedPaths: isolated.changes.slice(0, 500) } : { kind: 'commit' }),
    };
    project.snapshots = [...(project.snapshots ?? []), snapshot].slice(-50);
    project.commit = commit;
    project.branch = info.branch;
    project.refreshedAt = snapshot.at;
    await persist();
    return { project, snapshot };
  }

  async function createRun(body) {
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 160) : null;
    const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : null;
    if (!title || !prompt) throw new Error('title and prompt are required');
    if (!PROVIDER_DEFS[body.provider]) throw new Error('provider must be claude, kimi, deepseek, or demo');
    if (!projectFor(state, body.projectId)) throw new Error('projectId must reference a registered project');
    const mode = body.mode === 'read' || body.mode === 'edit' ? body.mode : null;
    if (!mode) throw new Error('mode must be read or edit');
    const maxTurns = body.maxTurns == null ? DEFAULT_MAX_TURNS : Number(body.maxTurns);
    const timeoutSeconds = body.timeoutSeconds == null ? DEFAULT_TIMEOUT_SECONDS : Number(body.timeoutSeconds);
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100) throw new Error('maxTurns must be an integer from 1 to 100');
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 7200) throw new Error('timeoutSeconds must be an integer from 1 to 7200');
    let budgetUsd = body.budgetUsd == null ? undefined : Number(body.budgetUsd);
    if (budgetUsd != null && (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 10000)) throw new Error('budgetUsd must be greater than 0 and at most 10000');
    const project = projectFor(state, body.projectId);
    const sourceCommit = body.sourceCommit == null ? project.commit : await resolveCommit(project.path, body.sourceCommit);
    const allowedPaths = normalizeAllowedPaths(body.allowedPaths);
    if (mode === 'read' && allowedPaths?.length) throw new Error('allowedPaths applies to edit runs only');
    const def = PROVIDER_DEFS[body.provider];
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim().slice(0, 120) : def.model;
    const run = { id: `run_${randomUUID()}`, title, prompt: truncate(prompt, 30_000), provider: body.provider, model, projectId: body.projectId, sourceCommit, ...(allowedPaths ? { allowedPaths } : {}), status: 'queued', createdAt: now(), mode, maxTurns, timeoutSeconds, logs: [] };
    if (PAID_PROVIDERS.includes(body.provider)) {
      // Admission: reserve against the persistent build allocation before queueing.
      if (budgetUsd == null) budgetUsd = ledger.summary().providers[body.provider]?.defaultTargetUsd ?? undefined;
      const admission = await ledger.reserve({ provider: body.provider, runId: run.id, model, targetUsd: budgetUsd });
      if (!admission.ok) { const err = new Error(admission.reason); err.status = 409; throw err; }
      run.budget = budgetView(admission.entry);
      appendLog(run, 'budget', `Reserved ${run.budget.reservedUsd} USD (${admission.entry.basis}).`);
    }
    if (budgetUsd != null) run.budgetUsd = budgetUsd;
    appendLog(run, 'system', `Run queued at pinned commit ${sourceCommit.slice(0, 12)}.`);
    state.runs.push(run); trimRuns(); queue.push(run.id);
    try { await persist(); } catch (err) {
      // Remove the run entirely so no later pump() can execute it without a live reservation.
      state.runs = state.runs.filter((item) => item.id !== run.id);
      const index = queue.indexOf(run.id); if (index >= 0) queue.splice(index, 1);
      if (run.budget?.entryId) await ledger.close(run.budget.entryId, { neverStarted: true, reason: 'run could not be persisted' });
      throw err;
    }
    pump(); return run;
  }

  /** Keep at most MAX_RUNS records, evicting the oldest finished ones; active runs are never evicted. */
  function trimRuns() {
    let excess = state.runs.length - MAX_RUNS;
    if (excess <= 0) return;
    state.runs = state.runs.filter((item) => {
      if (excess > 0 && item.status !== 'queued' && item.status !== 'running') { excess -= 1; return false; }
      return true;
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', `http://${requestHost(req) || '127.0.0.1'}`);
    const mutation = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE';
    const auth = authorizeRequest(req, { mutation });
    if (!auth.ok) return errorBody(res, auth.status, auth.error);
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, service: 'crew-desk', time: now() });
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { ...publicState(state, providers()), budget: ledger.summary() });
    if (req.method === 'GET' && url.pathname === '/api/runs') return json(res, 200, { runs: state.runs });
    if (req.method === 'GET' && url.pathname === '/api/budget') return json(res, 200, { budget: ledger.summary(), entries: ledger.entries() });
    const reconcileMatch = url.pathname.match(/^\/api\/budget\/entries\/([^/]+)\/reconcile$/);
    if (req.method === 'POST' && reconcileMatch) {
      try {
        const entry = await ledger.reconcile(reconcileMatch[1], await readBody(req));
        const run = runFor(state, entry.runId);
        if (run) { run.budget = budgetView(ledger.entry(entry.id)); appendLog(run, 'budget', `Reconciled to ${run.budget.settledUsd} USD: ${entry.reconciliation.source}`); await persist(); }
        return json(res, 200, { entry: ledger.entry(entry.id) });
      } catch (err) { return errorBody(res, 400, err.message); }
    }
    const laneMatch = url.pathname.match(/^\/api\/budget\/providers\/([^/]+)\/(pause|resume|balance|allocation)$/);
    if (req.method === 'POST' && laneMatch) {
      try {
        const body = await readBody(req);
        if (laneMatch[2] === 'allocation') {
          await ledger.setAllocation(laneMatch[1], Number(body.allocationUsd), body.reason);
          return json(res, 200, { budget: ledger.summary() });
        }
        if (laneMatch[2] === 'balance') {
          const amount = Number(body.amount);
          if (!Number.isFinite(amount) || typeof body.currency !== 'string' || typeof body.source !== 'string' || body.source.trim().length < 3) throw new Error('amount, currency and source are required');
          const record = await ledger.recordBalance(laneMatch[1], { kind: 'manual', amount, currency: body.currency.trim().slice(0, 8), source: body.source.trim().slice(0, 300) });
          return json(res, 201, { balance: record });
        }
        await ledger.setPaused(laneMatch[1], laneMatch[2] === 'pause', body.reason);
        return json(res, 200, { budget: ledger.summary() });
      } catch (err) { return errorBody(res, 400, err.message); }
    }
    const balanceCheckMatch = url.pathname.match(/^\/api\/budget\/providers\/([^/]+)\/balance-check$/);
    if (req.method === 'POST' && balanceCheckMatch) {
      try { return json(res, 201, { balance: await checkProviderBalance(balanceCheckMatch[1]) }); } catch (err) { return errorBody(res, 400, redact(err.message)); }
    }
    if (req.method === 'POST' && url.pathname === '/api/budget/reload-pricing') {
      const loaded = await ledger.reloadPricing();
      return json(res, loaded.ok ? 200 : 400, { ok: loaded.ok, error: loaded.error ?? null, budget: ledger.summary() });
    }
    const refreshMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/refresh$/);
    if (req.method === 'POST' && refreshMatch) {
      try { return json(res, 200, await refreshProject(refreshMatch[1], await readBody(req))); } catch (err) { return errorBody(res, err.status || 400, err.message); }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/runs/')) {
      const parts = url.pathname.split('/').filter(Boolean); const run = runFor(state, parts[2]);
      if (!run) return errorBody(res, 404, 'Run not found');
      if (parts[3] === 'diff') return json(res, 200, { runId: run.id, diff: run.diff || await diffForWorktree(run.worktreePath) });
      return json(res, 200, { run: snapshotRun(run) });
    }
    if (req.method === 'POST' && url.pathname === '/api/projects') {
      try { const project = await registerProject(await readBody(req)); return json(res, 201, { project }); } catch (err) { return errorBody(res, 400, err.message); }
    }
    if (req.method === 'POST' && url.pathname === '/api/runs') {
      try { const run = await createRun(await readBody(req)); return json(res, 202, { run: snapshotRun(run) }); } catch (err) { return errorBody(res, err.status || 400, err.message); }
    }
    if (req.method === 'POST' && url.pathname === '/api/demo') {
      try {
        const projectInfo = await ensureDemoProject(dataDir);
        const project = await registerProject({ path: projectInfo.path, name: 'Crew Desk offline demo' });
        const run = await createRun({ title: 'Offline demo rehearsal', prompt: 'Run the deterministic demo edit and verify the test.', provider: 'demo', projectId: project.id, mode: 'edit', maxTurns: 1, timeoutSeconds: 120 });
        return json(res, 202, { project, run: snapshotRun(run) });
      } catch (err) { return errorBody(res, 500, err.message); }
    }
    const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      const run = runFor(state, cancelMatch[1]);
      if (!run) return errorBody(res, 404, 'Run not found');
      if (run.status === 'queued') {
        // Remove it from the queue synchronously, then close the ledger, then publish the terminal status.
        const index = queue.indexOf(run.id); if (index >= 0) queue.splice(index, 1);
        run._cancelRequested = true;
        if (run.budget?.entryId) {
          const closed = await ledger.close(run.budget.entryId, { neverStarted: true, reason: 'cancelled before the provider process started' });
          if (closed) run.budget = budgetView(closed);
        }
        delete run._cancelRequested;
        appendLog(run, 'system', 'Run cancelled before start.'); run.finishedAt = now(); run.status = 'cancelled';
        await persist(); return json(res, 200, { run: snapshotRun(run) });
      }
      if (run.status === 'running' && finishing.has(run.id)) return errorBody(res, 409, 'This run is already finishing; its outcome can no longer be cancelled.');
      if (run.status === 'running') { run._cancelRequested = true; appendLog(run, 'system', 'Cancellation requested.'); await persist(); void killProcessTree(activeChildren.get(run.id)); return json(res, 202, { run: snapshotRun(run) }); }
      return json(res, 200, { run: snapshotRun(run) });
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(rootDir, req, res, url.pathname);
    return errorBody(res, 404, 'Not found');
  }

  async function serveStatic(base, req, res, pathname) {
    const dist = path.join(base, 'dist');
    let requested = pathname === '/' ? '/index.html' : pathname;
    let target;
    try { target = path.resolve(dist, `.${decodeURIComponent(requested)}`); } catch { return errorBody(res, 400, 'Invalid path'); }
    if (!target.startsWith(`${dist}${path.sep}`) && target !== dist) return errorBody(res, 400, 'Invalid path');
    try {
      const data = await fs.readFile(target);
      const ext = path.extname(target).toLowerCase();
      const contentType = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream';
      res.statusCode = 200; res.setHeader('Content-Type', contentType); res.end(data);
    } catch (err) { if (pathname !== '/') return serveStatic(base, req, res, '/'); errorBody(res, err.code === 'ENOENT' ? 404 : 500, 'Static asset not found'); }
  }

  const server = http.createServer((req, res) => { void handle(req, res).catch((err) => errorBody(res, 500, redact(err.message || 'Internal server error'))); });
  return {
    server,
    state,
    config,
    providers,
    async start(port = Number(options.port ?? process.env.HARNESS_PORT ?? DEFAULT_PORT)) { await fs.mkdir(dataDir, { recursive: true }); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); const address = server.address(); return typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : `http://127.0.0.1:${port}`; },
    async close() { for (const child of activeChildren.values()) await killProcessTree(child); await new Promise((resolve) => server.close(resolve)); await writeQueue; await releaseLock(); },
    ledger,
    /** Re-check the queue after settings change (used by tests). */
    resumeQueue() { pump(); },
  };
}

export { diffForWorktree, providerLaunch, redact, resolveClaudeLaunch, PROVIDER_DEFS };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const app = await createHarnessServer();
  const url = await app.start();
  process.stdout.write(`Crew Desk is running at ${url}\n`);
}
