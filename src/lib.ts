// Shared types and plain-language helpers for the Crew Desk UI.
// Field names mirror server/index.mjs exactly; only the words shown to people change.

export type Provider = {
  id: string;
  name: string;
  model?: string | null;
  available: boolean;
  status: string;
  detail?: string;
  billing?: string;
  endpoint?: string | null;
};

export type ProjectSnapshot = { commit: string; previousCommit?: string; at: string; reason?: string; kind?: 'commit' | 'working-tree'; contains?: string; uncommittedPaths?: number };
export type Project = { id: string; name: string; path: string; commit?: string; branch?: string | null; snapshots?: ProjectSnapshot[]; refreshedAt?: string };

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

// The server stores log messages as strings, but older state files or future
// event shapes may carry objects, so the UI treats the message as unknown.
export type LogEntry = { at: string; type: string; message: unknown };

export type Task = {
  id: string;
  source?: 'imported';
  sourceSessionId?: string;
  importedAt?: string;
  title: string;
  prompt: string;
  provider: string;
  model?: string | null;
  projectId: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  worktreePath?: string;
  branch?: string;
  mode: 'read' | 'edit';
  maxTurns: number;
  timeoutSeconds: number;
  budgetUsd?: number;
  result?: string;
  error?: string;
  logs?: LogEntry[];
  usage?: RunUsage;
  budget?: RunBudget;
  liveEstimateUsd?: number | null;
  sourceCommit?: string;
  allowedPaths?: string[];
  scope?: { allowedPaths: string[] | null; changedFiles: string[]; outOfScope: string[] };
  diff?: string;
};

/** Token categories are disjoint and summed once; null means not reported (unknown), never zero. */
export type UsageTotals = { inputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; outputTokens: number | null };

export type RunUsage = {
  source?: string;
  completeness?: 'reported' | 'reported-partial' | 'partial' | 'unknown';
  missingCategories?: string[];
  totals?: UsageTotals;
  perModel?: Record<string, UsageTotals> | null;
  requestedModel?: string | null;
  reportedModels?: string[];
  modelsMatch?: boolean | null;
  apiMessages?: number;
  cliReportedCostUsd?: number | null;
  cliCostNote?: string;
  providerEstimateUsd?: number | null;
  providerEstimateComplete?: boolean;
  providerEstimateBasis?: string;
  // Older records only carried these two counters (and sometimes a CLI estimate).
  inputTokens?: number | null;
  outputTokens?: number | null;
  estimatedCostUsd?: number;
  costSource?: string;
};

export type LedgerStatus = 'reserved' | 'settled' | 'uncertain' | 'released' | 'reconciled';

export type RunBudget = {
  entryId: string;
  provider: string;
  status: LedgerStatus;
  targetUsd: number;
  reservedUsd: number;
  estimateUsd: number | null;
  settledUsd: number | null;
  basis: string;
  reason: string | null;
  priceCheckedAt: string | null;
  reconciliation: { source: string; at: string } | null;
};

export type BalanceRecord = { at: string; kind: string; ok?: boolean; source?: string; balances?: Array<{ currency: string; total: number | null }>; amount?: number; currency?: string; httpStatus?: number; error?: string };

export type BudgetProvider = {
  allocationUsd: number;
  settledUsd: number;
  reservedUsd: number;
  uncertainUsd: number;
  remainingUsd: number;
  laneOpen: boolean;
  laneReason: string | null;
  paused: boolean;
  pauseReason: string | null;
  perTaskMaxUsd: number | null;
  defaultTargetUsd: number | null;
  priceCards: Array<{ model: string; status: string; checkedAt: string | null; sources: string[] }>;
  lastBalance: BalanceRecord | null;
  baselineBalance: BalanceRecord | null;
  entries: number;
};

export type BudgetSummary = { build: { id: string; createdAt: string; allocationSource: string; note: string }; providers: Record<string, BudgetProvider>; costBasis: string };

export type AppState = { projects: Project[]; providers: Provider[]; runs: Task[]; settings: { maxConcurrent: number }; budget?: BudgetSummary };

// Payload for POST /api/runs. Names are the server's contract; do not rename.
export type TaskPayload = {
  title: string;
  prompt: string;
  provider: string;
  projectId: string;
  mode: 'read' | 'edit';
  maxTurns: number;
  timeoutSeconds: number;
  budgetUsd?: number;
  model?: string;
};

export const emptyState: AppState = { projects: [], providers: [], runs: [], settings: { maxConcurrent: 2 } };

export const DEMO_PROVIDER = 'demo';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

export function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/* ---------- Money and tokens ---------- */

/** USD with enough precision for small API charges; never rounds a charge to zero. */
export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'unknown';
  if (value === 0) return '$0.00';
  if (Math.abs(value) < 0.01) return `$${value.toFixed(6).replace(/0+$/, '')}`;
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number | null | undefined): string {
  return value == null ? 'not reported' : value.toLocaleString();
}

export const LEDGER_STATUS: Record<LedgerStatus, { label: string; tone: Tone; explain: string }> = {
  reserved: { label: 'Reserved', tone: 'info', explain: 'Money is set aside from the build allocation while this task may still be charged.' },
  settled: { label: 'Settled (estimate)', tone: 'success', explain: 'Charged at an estimate from reported tokens × published prices. Not a provider bill.' },
  uncertain: { label: 'Charge uncertain', tone: 'danger', explain: 'Usage was incomplete, so the reservation stays counted until it is reconciled with the provider.' },
  released: { label: 'Released', tone: 'neutral', explain: 'The worker never started, so nothing could be charged.' },
  reconciled: { label: 'Reconciled', tone: 'success', explain: 'Matched against provider usage or billing.' },
};

/* ---------- Time ---------- */

function validDate(iso?: string): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatTime(iso?: string): string {
  const date = validDate(iso);
  return date ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—';
}

export function formatWhen(iso?: string): string {
  const date = validDate(iso);
  if (!date) return '—';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const yesterday = new Date(today.getTime() - 86_400_000).toDateString() === date.toDateString();
  const day = sameDay ? 'Today' : yesterday ? 'Yesterday' : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${day}, ${formatTime(iso)}`;
}

export function formatDuration(startIso?: string, endIso?: string): string | null {
  const start = validDate(startIso);
  const end = validDate(endIso);
  if (!start || !end) return null;
  const seconds = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} sec`;
  return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

export function newestFirst(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/* ---------- Labels ---------- */

export type Tone = 'neutral' | 'info' | 'working' | 'success' | 'danger' | 'practice';

export const STATUS_INFO: Record<TaskStatus, { label: string; tone: Tone; explain: string }> = {
  queued: { label: 'Waiting to start', tone: 'info', explain: 'In line. It starts when a slot is free.' },
  running: { label: 'Working', tone: 'working', explain: 'The assistant is working on this now.' },
  completed: { label: 'Done', tone: 'success', explain: 'Finished. Review the answer and file changes.' },
  failed: { label: 'Failed', tone: 'danger', explain: 'Stopped with a problem. See the message below.' },
  cancelled: { label: 'Stopped', tone: 'neutral', explain: 'You stopped this task.' },
  interrupted: { label: 'Interrupted', tone: 'danger', explain: 'The Crew Desk server restarted before this task finished.' },
};

export function statusInfo(status: string) {
  return STATUS_INFO[status as TaskStatus] ?? { label: status, tone: 'neutral' as Tone, explain: '' };
}

export function isActive(task: Task): boolean {
  return task.status === 'running' || task.status === 'queued';
}

export function isDemoTask(task: Task): boolean {
  return task.provider === DEMO_PROVIDER;
}

export function modeLabel(mode: Task['mode']): string {
  return mode === 'edit' ? 'Make changes in a separate copy' : 'Review files';
}

export function providerName(id: string, providers: Provider[]): string {
  if (id === DEMO_PROVIDER) return 'Practice demo';
  if (id === 'kimi') return 'Kimi';
  if (id === 'deepseek') return 'DeepSeek';
  return providers.find((provider) => provider.id === id)?.name ?? id;
}

export function projectName(id: string, projects: Project[]): string {
  return projects.find((project) => project.id === id)?.name ?? 'Removed project';
}

/**
 * Plain-language readiness. "Installed" or "key added" is never treated as
 * proof of a working sign-in or a positive balance; that is only known once a
 * task actually starts.
 */
export function readiness(provider: Provider): { label: string; tone: Tone; explain: string } {
  if (provider.id === DEMO_PROVIDER) return { label: 'Practice only', tone: 'practice', explain: 'Makes a fixed, pre-written change to a sample project. No AI or credits used.' };
  if (provider.status === 'installed') return { label: 'Installed, sign-in checked when a task starts', tone: 'info', explain: 'Claude Code is installed on this computer. Crew Desk cannot see whether you are signed in until a task runs.' };
  if (provider.status === 'configured') return { label: 'Key added, not yet verified', tone: 'info', explain: 'An access key is set on the server. Starting a task tests whether it works. Check your AI account for the remaining balance.' };
  if (provider.status === 'unconfigured') return { label: 'Needs setup', tone: 'danger', explain: 'An access key has not been added to the server yet.' };
  if (provider.status === 'unavailable') return { label: 'Needs setup', tone: 'danger', explain: 'Claude Code is not installed on this computer, so this assistant cannot run.' };
  return provider.available
    ? { label: 'Available', tone: 'info', explain: 'Reported as available by the server.' }
    : { label: 'Not available', tone: 'danger', explain: provider.detail ?? 'The server reports this assistant cannot run.' };
}

/** What someone needs to do to set up an assistant. Keys always live on the server, never in the browser. */
export const SETUP_STEPS: Record<string, { steps: string[]; code?: string }> = {
  claude: { steps: ['Install Claude Code on the computer running Crew Desk.', 'Sign in once from a terminal.'], code: 'claude auth login' },
  kimi: { steps: ['Needs Claude Code installed.', 'Add your Kimi key to the server’s .env file, then restart the server.'], code: 'MOONSHOT_API_KEY=…' },
  deepseek: { steps: ['Needs Claude Code installed.', 'Add your DeepSeek key to the server’s .env file, then restart the server.'], code: 'DEEPSEEK_API_KEY=…' },
};

/* ---------- Activity log ---------- */

const LOG_TYPE_LABELS: Record<string, string> = {
  system: 'Crew Desk',
  assistant: 'Assistant',
  user: 'Tool result',
  stdout: 'Output',
  stderr: 'Error output',
  error: 'Error',
  git: 'Working copy',
  test: 'Tests',
  demo: 'Practice demo',
};

export function logTypeLabel(type: string): string {
  return LOG_TYPE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

/** Turn any log payload into readable text instead of "[object Object]". */
export function logMessageText(message: unknown): string {
  if (message === '[object Object]') return 'This older activity entry did not preserve readable tool details.';
  if (typeof message === 'string') return message;
  if (message == null) return '';
  if (typeof message === 'number' || typeof message === 'boolean') return String(message);
  try {
    return JSON.stringify(message, null, 2);
  } catch {
    return String(message);
  }
}

/* ---------- File changes ---------- */

export type DiffFile = { path: string; kind: 'added' | 'deleted' | 'changed'; added: number; removed: number; binary: boolean; lines: string[] };

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = { path: header[2], kind: 'changed', added: 0, removed: 0, binary: false, lines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file mode')) { current.kind = 'added'; continue; }
    if (line.startsWith('deleted file mode')) { current.kind = 'deleted'; continue; }
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) { current.binary = true; continue; }
    if (current.binary || /^(index |--- |\+\+\+ |similarity |rename |old mode|new mode)/.test(line)) continue;
    if (line.startsWith('+')) current.added += 1;
    else if (line.startsWith('-')) current.removed += 1;
    current.lines.push(line);
  }
  return files;
}
