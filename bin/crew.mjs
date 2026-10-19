#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { request, compactState } from './client.mjs';

const [command = 'help', ...args] = process.argv.slice(2);
const help = `Crew Desk: local worker control

node bin/crew.mjs status
node bin/crew.mjs project "C:/absolute/path/to/git-repo" "Optional name"
node bin/crew.mjs run task.json
node bin/crew.mjs run -                  (read task JSON from stdin)
node bin/crew.mjs show RUN_ID
node bin/crew.mjs logs RUN_ID
node bin/crew.mjs diff RUN_ID
node bin/crew.mjs patch RUN_ID [FILE]    (write the change as a patch file for git apply)
node bin/crew.mjs cancel RUN_ID
node bin/crew.mjs demo                   (local deterministic rehearsal, no AI)
node bin/crew.mjs refresh PROJECT_ID [COMMIT] "reason"   (move snapshot to HEAD or COMMIT)
node bin/crew.mjs snapshot PROJECT_ID "reason"          (isolated working-tree snapshot; HEAD/index/files untouched)
node bin/crew.mjs budget                 (build-budget ledger summary and compact entries)
node bin/crew.mjs balance deepseek|kimi  (provider account balance; numbers only)
node bin/crew.mjs reconcile ENTRY_ID ACTUAL_USD "source"
node bin/crew.mjs pause|resume deepseek|kimi "reason"
node bin/crew.mjs allocation deepseek|kimi USD "reason"   (owner-directed; history kept)

Task JSON: {"title":"Review module","prompt":"Inspect and report findings",
"provider":"claude","projectId":"ID_FROM_STATUS","mode":"read",
"maxTurns":6,"timeoutSeconds":300}
Optional: "model" (e.g. "sonnet"/"haiku" for claude), "sourceCommit" (pin a commit;
default = project snapshot), "allowedPaths" (edit runs), "budgetUsd" (paid task target).
Paid runs (kimi, deepseek) are admitted only with a ledger reservation.

Providers: claude (subscription), kimi (paid API), deepseek (paid API).
Start the server first: npm start. Default: http://127.0.0.1:4317
Use HARNESS_URL to select a different loopback port. No credentials go in task JSON.
`;

async function input() {
  if (!args[0]) throw new Error('Supply a task JSON file or - for stdin.');
  if (args[0] !== '-') return JSON.parse(await readFile(args[0], 'utf8'));
  let data = '';
  for await (const chunk of process.stdin) { data += chunk; if (data.length > 100000) throw new Error('Task input too large.'); }
  return JSON.parse(data);
}
function id() { if (!args[0]) throw new Error('A run ID is required.'); return encodeURIComponent(args[0]); }
try {
  let result;
  switch (command) {
    case 'help': case '--help': console.log(help); break;
    case 'status': result = await compactState(); break;
    case 'project':
      if (!args[0]) throw new Error('A Git repository path is required.');
      result = await request('/api/projects', { path: args[0], name: args[1] }); break;
    case 'run': result = await request('/api/runs', await input()); break;
    case 'show': result = await request(`/api/runs/${id()}`); break;
    case 'logs': { const response = await request(`/api/runs/${id()}`); result = (response.run || response).logs; break; }
    case 'diff': result = await request(`/api/runs/${id()}/diff`); break;
    case 'patch': {
      // Written by Node as UTF-8, so it works where a shell redirect would not (Windows PowerShell 5.1 writes UTF-16).
      const { diff } = await request(`/api/runs/${id()}/diff`);
      if (!diff?.trim()) throw new Error('This run changed no files.');
      if (diff.startsWith('Unable to collect diff') || diff.endsWith('…[truncated]')) throw new Error('The recorded diff is incomplete; apply this run by hand from its worktree.');
      const file = path.resolve(args[1] || `run-${args[0]}.patch`);
      await writeFile(file, diff.endsWith('\n') ? diff : `${diff}\n`, 'utf8');
      result = { patch: file, apply: `git -C "PATH/TO/YOUR/REPO" apply --3way "${file}"` }; break;
    }
    case 'cancel': result = await request(`/api/runs/${id()}/cancel`, {}); break;
    case 'demo': result = await request('/api/demo', {}); break;
    case 'refresh': {
      if (!args[0]) throw new Error('A project ID is required.');
      const commit = args[1] && /^[0-9a-f]{7,40}$/i.test(args[1]) ? args[1] : undefined;
      const reason = commit ? args[2] : args[1];
      result = await request(`/api/projects/${encodeURIComponent(args[0])}/refresh`, { ...(commit ? { commit } : {}), ...(reason ? { reason } : {}) });
      result = { project: { id: result.project.id, commit: result.project.commit }, snapshot: result.snapshot }; break;
    }
    case 'snapshot': {
      if (!args[0]) throw new Error('A project ID is required.');
      result = await request(`/api/projects/${encodeURIComponent(args[0])}/refresh`, { includeWorkingTree: true, reason: args[1] || 'isolated working-tree snapshot' });
      result = { project: { id: result.project.id, commit: result.project.commit }, snapshot: result.snapshot }; break;
    }
    case 'budget': {
      const response = await request('/api/budget');
      result = { budget: response.budget, entries: response.entries.map(({ id, runId, provider, model, status, reservedUsd, estimateUsd, settledUsd, history }) => ({ id, runId, provider, model, status, reservedUsd, estimateUsd, settledUsd, reason: history?.at(-1)?.reason })) };
      break;
    }
    case 'balance': result = await request(`/api/budget/providers/${encodeURIComponent(args[0] || '')}/balance-check`, {}); break;
    case 'reconcile':
      if (args.length < 3) throw new Error('Usage: reconcile ENTRY_ID ACTUAL_USD "source"');
      result = await request(`/api/budget/entries/${encodeURIComponent(args[0])}/reconcile`, { actualUsd: Number(args[1]), source: args[2], note: args[3] }); break;
    case 'allocation':
      if (args.length < 3) throw new Error('Usage: allocation PROVIDER USD "reason"');
      result = await request(`/api/budget/providers/${encodeURIComponent(args[0])}/allocation`, { allocationUsd: Number(args[1]), reason: args[2] });
      result = result.budget.providers[args[0]]; break;
    case 'pause': case 'resume':
      if (!args[0] || !args[1]) throw new Error(`Usage: ${command} PROVIDER "reason"`);
      result = await request(`/api/budget/providers/${encodeURIComponent(args[0])}/${command}`, { reason: args[1] }); break;
    default: throw new Error(`Unknown command: ${command}. Run --help.`);
  }
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
