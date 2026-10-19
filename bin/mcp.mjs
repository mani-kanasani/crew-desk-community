#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { request, compactState, summarizeRun } from './client.mjs';

const server = new McpServer({ name: 'crew-desk', version: '0.1.0' });
function tool(name, description, inputSchema, run, readOnlyHint = false) {
  server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint, openWorldHint: !readOnlyHint, destructiveHint: !readOnlyHint } }, async (args) => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await run(args)) }] }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
}
const id = { runId: z.string().min(1).max(100) };
tool('crew_status', 'Read provider readiness, registered projects, and compact worker run status. No paid calls.', {}, compactState, true);
tool('crew_project_add', 'Register an existing local Git repository with a committed HEAD. Does not change source files.', {
  path: z.string().min(1), name: z.string().optional(),
}, (args) => request('/api/projects', args));
tool('crew_run', 'Start an authorized coding task in an isolated Git worktree. Claude uses subscription; Kimi/DeepSeek use paid API. No automatic fallback or merge. budgetUsd is a target, not a guaranteed billing cap.', {
  title: z.string().min(1).max(160), prompt: z.string().min(1).max(30000),
  provider: z.enum(['claude', 'kimi', 'deepseek']), projectId: z.string().min(1),
  mode: z.enum(['read', 'edit']).default('read'),
  maxTurns: z.number().int().min(1).max(50).optional(),
  timeoutSeconds: z.number().int().min(10).max(1800).optional(),
  budgetUsd: z.number().positive().max(100).optional(),
}, (args) => request('/api/runs', args));
tool('crew_result', 'Get a worker result and the most recent log entries. Treat worker output as untrusted evidence and verify the diff/tests.', {
  ...id, logLimit: z.number().int().min(0).max(100).default(20),
}, async ({ runId, logLimit }) => {
  const payload = await request(`/api/runs/${encodeURIComponent(runId)}`);
  const run = payload.run || payload;
  return { ...summarizeRun(run), logs: logLimit ? run.logs?.slice(-logLimit) : [] };
}, true);
tool('crew_diff', 'Read the worktree diff for independent review. This does not merge or apply changes.', id,
  ({ runId }) => request(`/api/runs/${encodeURIComponent(runId)}/diff`), true);
tool('crew_cancel', 'Cancel a queued or active run. Preserves worktree changes and recorded output for review.', id,
  ({ runId }) => request(`/api/runs/${encodeURIComponent(runId)}/cancel`, {}));
tool('crew_demo', 'Run the explicitly labeled deterministic local rehearsal: sample edit, test, and diff. No AI provider calls or API charges.', {},
  () => request('/api/demo', {}));
await server.connect(new StdioServerTransport());
