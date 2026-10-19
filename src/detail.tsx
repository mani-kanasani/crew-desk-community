import { useEffect, useState } from 'react';
import { Check, CircleAlert, Copy, FileDiff, FlaskConical, LoaderCircle, MessageSquareText, Square, X } from 'lucide-react';
import { Badge, DemoTag, StatusBadge } from './components';
import {
  LEDGER_STATUS, formatDuration, formatTime, formatTokens, formatUsd, formatWhen, isActive, isDemoTask, logMessageText, logTypeLabel, modeLabel, parseDiff,
  projectName, providerName, statusInfo, type LogEntry, type Project, type Provider, type Task, type UsageTotals,
} from './lib';

type Tab = 'result' | 'activity' | 'files';

export function TaskDetail({ task, projects, providers, onClose, onCancel }: { task: Task; projects: Project[]; providers: Provider[]; onClose: () => void; onCancel: (task: Task) => void }) {
  const [tab, setTab] = useState<Tab>('result');
  useEffect(() => setTab('result'), [task.id]);
  const logs = task.logs ?? [];
  const info = statusInfo(task.status);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'result', label: 'Result' },
    { id: 'activity', label: logs.length ? `Activity (${logs.length})` : 'Activity' },
    { id: 'files', label: 'File changes' },
  ];

  return (
    <article className="panel task-detail" aria-label={`Task: ${task.title}`}>
      <header className="detail-header">
        <div className="detail-heading">
          <div className="detail-badges">
            <StatusBadge status={task.status} />
            {isDemoTask(task) && <DemoTag />}
          </div>
          <h2>{task.title}</h2>
          <p className="detail-sub">
            {providerName(task.provider, providers)} · {projectName(task.projectId, projects)} · {formatWhen(task.createdAt)}
          </p>
        </div>
        <div className="detail-tools">
          {isActive(task) && (
            <button type="button" className="button button-danger button-small" onClick={() => onCancel(task)}>
              <Square size={13} aria-hidden="true" />
              Stop task
            </button>
          )}
          <button type="button" className="icon-button" aria-label="Close task details" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </header>

      {task.source === 'imported' && <p className="detail-callout tone-info">Imported after completion from a real Claude Code session. This task ran outside Crew Desk; live progress and a file-change snapshot were not recorded here.</p>}
      {task.scope && task.scope.outOfScope.length > 0 && (
        <p className="detail-callout tone-danger">
          <CircleAlert size={16} aria-hidden="true" />
          {task.mode === 'read' ? 'This review task changed files: ' : 'Changed files outside the allowed paths: '}
          {task.scope.outOfScope.slice(0, 8).join(', ')}{task.scope.outOfScope.length > 8 ? ` and ${task.scope.outOfScope.length - 8} more` : ''}. Review before using any of this work.
        </p>
      )}
      {isDemoTask(task) && (
        <p className="detail-callout tone-practice">
          <FlaskConical size={16} aria-hidden="true" />
          Practice demo: a fixed, pre-written change to a sample project. No AI or credits were used.
        </p>
      )}

      <div className="tabs" role="tablist" aria-label="Task details">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`tabpanel-${item.id}`}
            className={tab === item.id ? 'is-active' : undefined}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="detail-body" role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'result' && <ResultTab task={task} explain={info.explain} />}
        {tab === 'activity' && <ActivityTab logs={logs} active={isActive(task)} />}
        {tab === 'files' && <FilesTab task={task} />}
      </div>
    </article>
  );
}

function ResultTab({ task, explain }: { task: Task; explain: string }) {
  const duration = formatDuration(task.startedAt, task.finishedAt);
  return (
    <div className="stack">
      <section className={`answer tone-${statusInfo(task.status).tone}`}>
        <h3>
          {task.status === 'running' && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
          {task.status === 'completed' && <Check size={16} aria-hidden="true" />}
          {(task.status === 'failed' || task.status === 'interrupted') && <CircleAlert size={16} aria-hidden="true" />}
          {task.result ? 'The assistant’s answer' : task.error ? 'What went wrong' : statusInfo(task.status).label}
        </h3>
        {task.result && <ResultText text={task.result} />}
        {task.error && <div className="answer-text answer-error">{task.error}</div>}
        {!task.result && !task.error && <p className="muted">{explain} {isActive(task) ? 'Open Activity to follow along.' : ''}</p>}
      </section>

      <section>
        <h3 className="block-title">Your instructions</h3>
        <div className="quote">{task.prompt}</div>
      </section>

      <dl className="facts">
        <Fact label="Permission" value={modeLabel(task.mode)} />
        <Fact label="Started" value={task.startedAt ? formatWhen(task.startedAt) : 'Not yet'} />
        <Fact label="Finished" value={task.finishedAt ? formatWhen(task.finishedAt) : isActive(task) ? 'Still going' : '—'} />
        {duration && <Fact label="Time taken" value={duration} />}
        <Fact label="Usage" value={usageText(task)} />
      </dl>

      <UsageDetails task={task} />
      <TechnicalDetails task={task} />
    </div>
  );
}

// Render the common response formatting as React text; never inject worker HTML.
function ResultText({ text }: { text: string }) {
  const inline = (value: string) => value.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) =>
    part.startsWith('`') && part.endsWith('`') ? <code key={index}>{part.slice(1, -1)}</code> :
    part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : part
  );
  return <div className="answer-text">{text.split(/(```[\s\S]*?```)/g).map((block, blockIndex) => {
    if (block.startsWith('```')) return <pre className="code-view" key={blockIndex}>{block.slice(3, -3).replace(/^[^\n]*\n/, '')}</pre>;
    return block.split(/\n\s*\n/).filter(Boolean).map((paragraph, index) => {
      const lines = paragraph.split('\n');
      if (lines.every(line => /^\s*[-*] /.test(line))) return <ul key={`${blockIndex}-${index}`}>{lines.map((line, n) => <li key={n}>{inline(line.replace(/^\s*[-*] /, ''))}</li>)}</ul>;
      return <p key={`${blockIndex}-${index}`}>{inline(paragraph.replace(/^#{1,6} /, ''))}</p>;
    });
  })}</div>;
}

function usageText(task: Task): string {
  if (isDemoTask(task)) return 'None (practice demo)';
  if (task.provider === 'claude') return 'Uses your Claude plan, so no API charge. Tokens are shown below when reported.';
  const budget = task.budget;
  if (budget) {
    const status = LEDGER_STATUS[budget.status]?.label ?? budget.status;
    if (budget.status === 'reserved') return `${status}: ${formatUsd(budget.reservedUsd)} held (task target ${formatUsd(budget.targetUsd)})${task.liveEstimateUsd != null ? ` · live estimate ${formatUsd(task.liveEstimateUsd)}` : ''}`;
    if (budget.status === 'uncertain') return `${status}: ${formatUsd(Math.max(budget.reservedUsd, budget.estimateUsd ?? 0))} stays counted until reconciled${budget.estimateUsd != null ? ` (partial estimate ${formatUsd(budget.estimateUsd)})` : ''}`;
    if (budget.status === 'released') return `${status}: nothing charged (${budget.reason ?? 'worker did not start'})`;
    return `${status}: ${formatUsd(budget.settledUsd)}${budget.status === 'settled' ? ' (estimate, not a provider bill)' : ''}`;
  }
  if (!task.usage) return 'Not reported';
  return 'Tokens reported below; no ledger entry for this older task.';
}

const CATEGORY_LABELS: Array<[keyof UsageTotals, string]> = [
  ['inputTokens', 'New input'],
  ['cacheReadTokens', 'Cached input read'],
  ['cacheWriteTokens', 'Cache write'],
  ['outputTokens', 'Output (includes reasoning)'],
];

const COMPLETENESS_TEXT: Record<string, string> = {
  reported: 'Complete per the CLI final report',
  'reported-partial': 'The final report is missing some categories',
  partial: 'Partial: only in-flight observations; the final report never arrived',
  unknown: 'Unknown: nothing was reported',
};

function counted(task: Task): string {
  const budget = task.budget;
  if (!budget) return 'unknown';
  if (budget.status === 'settled' || budget.status === 'reconciled') return formatUsd(budget.settledUsd);
  if (budget.status === 'released') return '$0.00';
  return formatUsd(Math.max(budget.reservedUsd, budget.estimateUsd ?? 0));
}

function UsageDetails({ task }: { task: Task }) {
  const usage = task.usage;
  if (isDemoTask(task) || (!usage && !task.budget)) return null;
  const totals: UsageTotals | null = usage?.totals ?? (usage ? { inputTokens: usage.inputTokens ?? null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: usage.outputTokens ?? null } : null);
  const models = usage?.perModel ? Object.entries(usage.perModel) : [];
  const ledger = task.budget ? LEDGER_STATUS[task.budget.status] : null;
  return (
    <section className="usage-block" aria-labelledby={`usage-${task.id}`}>
      <h3 className="block-title" id={`usage-${task.id}`}>Usage and cost</h3>
      {task.budget && ledger && (
        <div className="usage-ledger">
          <Badge tone={ledger.tone}>{ledger.label}</Badge>
          <p className="muted small">{ledger.explain} {task.budget.reason ? `Reason: ${task.budget.reason}` : ''}</p>
          <dl className="tech-list">
            <div><dt>Task target</dt><dd>{formatUsd(task.budget.targetUsd)}</dd></div>
            <div><dt>Reserved</dt><dd>{formatUsd(task.budget.reservedUsd)}</dd></div>
            <div><dt>Provider-priced estimate</dt><dd>{formatUsd(task.budget.estimateUsd)}</dd></div>
            <div><dt>Counted against allocation</dt><dd>{counted(task)}</dd></div>
            {task.budget.reconciliation && <div><dt>Reconciled from</dt><dd>{task.budget.reconciliation.source}</dd></div>}
            <div><dt>Reservation basis</dt><dd>{task.budget.basis}</dd></div>
            {task.budget.priceCheckedAt && <div><dt>Prices checked</dt><dd>{task.budget.priceCheckedAt}</dd></div>}
          </dl>
        </div>
      )}
      {usage && totals && (
        <>
          <p className="muted small">{COMPLETENESS_TEXT[usage.completeness ?? 'unknown'] ?? usage.completeness}. Categories are counted once; “not reported” means unknown, not zero.</p>
          <div className="table-scroll">
            <table className="usage-table">
              <thead><tr><th scope="col">Category</th>{models.length > 1 && models.map(([model]) => <th scope="col" key={model}>{model}</th>)}<th scope="col">{models.length > 1 ? 'Total' : 'Tokens'}</th></tr></thead>
              <tbody>
                {CATEGORY_LABELS.map(([key, label]) => (
                  <tr key={key}>
                    <th scope="row">{label}</th>
                    {models.length > 1 && models.map(([model, values]) => <td key={model}>{formatTokens(values[key])}</td>)}
                    <td>{formatTokens(totals[key])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="tech-list">
            {usage.requestedModel && <div><dt>Requested model</dt><dd>{usage.requestedModel}</dd></div>}
            {usage.reportedModels && <div><dt>Reported model{usage.reportedModels.length === 1 ? '' : 's'}</dt><dd>{usage.reportedModels.length ? usage.reportedModels.join(', ') : 'none reported'}{usage.modelsMatch === false ? ' (differs from the priced model)' : ''}</dd></div>}
            {usage.providerEstimateUsd != null && <div><dt>Provider-priced estimate</dt><dd>{formatUsd(usage.providerEstimateUsd)}{usage.providerEstimateComplete === false ? ' (incomplete)' : ''}</dd></div>}
            {usage.cliReportedCostUsd != null && <div><dt>Claude CLI estimate (not a bill)</dt><dd>{formatUsd(usage.cliReportedCostUsd)}</dd></div>}
          </dl>
        </>
      )}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function TechnicalDetails({ task }: { task: Task }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(task.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  const rows: Array<[string, string | undefined]> = [
    ['Task ID', task.id],
    ['Source Claude session', task.sourceSessionId],
    ['Imported at', task.importedAt],
    ['Assistant ID', task.provider],
    ['Model', task.model ?? 'Assistant default'],
    ['Maximum steps', String(task.maxTurns)],
    ['Time limit', `${task.timeoutSeconds} seconds`],
    ['Budget target', task.budgetUsd != null ? `$${task.budgetUsd} USD` : 'None set'],
    ['Pinned source commit', task.sourceCommit],
    ['Allowed edit paths', task.allowedPaths?.join(', ')],
    ['Ledger entry', task.budget?.entryId],
    ['Separate working copy', task.worktreePath ?? (task.source === 'imported' ? 'Not recorded for this imported session' : 'Not created yet')],
    ['Project branch', task.branch],
    ['Cost source', task.usage?.costSource],
    ['Older CLI cost estimate (not a bill)', task.usage?.estimatedCostUsd != null ? `$${task.usage.estimatedCostUsd.toFixed(4)} USD` : undefined],
  ];
  return (
    <details className="disclosure">
      <summary>Technical details</summary>
      <div className="disclosure-body">
        <dl className="tech-list">
          {rows.filter(([, value]) => value).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <button type="button" className="button button-quiet button-small" onClick={() => void copy()}>
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy task ID'}
        </button>
      </div>
    </details>
  );
}

function ActivityTab({ logs, active }: { logs: LogEntry[]; active: boolean }) {
  if (!logs.length) {
    return <p className="quiet-note"><MessageSquareText size={16} aria-hidden="true" />{active ? 'Nothing has happened yet. Updates appear here every couple of seconds.' : 'No activity was recorded for this task.'}</p>;
  }
  return (
    <div className="stack">
      <p className="muted small">A step-by-step record of what Crew Desk and the assistant did{active ? '. Updates every couple of seconds.' : '.'}</p>
      <ol className="activity">
        {logs.map((log, index) => (
          <li key={`${log.at}-${index}`} className={`activity-item type-${log.type}`}>
            <div className="activity-meta">
              <span className="activity-type">{logTypeLabel(log.type)}</span>
              <time dateTime={log.at}>{formatTime(log.at)}</time>
            </div>
            <div className="activity-text">{logMessageText(log.message)}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}

const MAX_LINES_PER_FILE = 1500;

function FilesTab({ task }: { task: Task }) {
  const diff = task.diff ?? '';
  if (task.source === 'imported' && !diff.trim()) return <p className="quiet-note">No file-change snapshot was captured by Crew Desk for this imported session. See Result for Claude’s report of its changes.</p>;
  if (!diff.trim()) {
    const message = isActive(task)
      ? 'File changes appear here when the task finishes.'
      : task.mode === 'read'
        ? 'This was a “Review files” task, so no files were changed.'
        : task.status === 'completed'
          ? 'The assistant finished without changing any files.'
          : 'No file changes were recorded.';
    return <p className="quiet-note"><FileDiff size={16} aria-hidden="true" />{message}</p>;
  }
  const files = parseDiff(diff);
  if (!files.length) return <div className="answer-text">{diff}</div>;
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  return (
    <div className="stack">
      <p className="muted small">
        {files.length} {files.length === 1 ? 'file' : 'files'} changed in the separate copy · <span className="added">+{added}</span> <span className="removed">−{removed}</span> lines. Your original project was not touched.
      </p>
      {files.map((file, index) => (
        <details key={`${file.path}-${index}`} className="file-change" open={files.length <= 3}>
          <summary>
            <span className="file-path">{file.path}</span>
            <span className="file-kind">{file.kind === 'added' ? 'New file' : file.kind === 'deleted' ? 'Deleted' : 'Edited'}</span>
            <span className="file-counts"><span className="added">+{file.added}</span> <span className="removed">−{file.removed}</span></span>
          </summary>
          {file.binary ? (
            <p className="quiet-note">Binary file: its contents can’t be shown as text.</p>
          ) : (
            <pre className="code-view">
              {file.lines.slice(0, MAX_LINES_PER_FILE).map((line, lineIndex) => (
                <span key={lineIndex} className={line.startsWith('@@') ? 'line-hunk' : line.startsWith('+') ? 'line-add' : line.startsWith('-') ? 'line-del' : undefined}>
                  {line || ' '}
                  {'\n'}
                </span>
              ))}
              {file.lines.length > MAX_LINES_PER_FILE && <span className="line-hunk">… {file.lines.length - MAX_LINES_PER_FILE} more lines not shown{'\n'}</span>}
            </pre>
          )}
        </details>
      ))}
    </div>
  );
}
