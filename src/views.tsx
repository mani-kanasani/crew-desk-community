import { useMemo, useState, type ReactNode } from 'react';
import {
  ArrowRight, Bot, Check, ClipboardList, Eye, FlaskConical, FolderGit2, FolderPlus, LoaderCircle, PencilLine, Plus, RefreshCw, Search, ShieldCheck, Wrench,
} from 'lucide-react';
import { Badge, DemoAction, EmptyState, ReadinessBadge, TaskRow, isDemoProvider } from './components';
import { TaskDetail } from './detail';
import { SETUP_STEPS, formatUsd, formatWhen, isActive, isDemoTask, readiness, type AppState, type BudgetProvider, type BudgetSummary, type Project, type Provider, type Task } from './lib';

type Actions = {
  onNewTask: () => void;
  onAddProject: () => void;
  onDemo: () => void;
  demoPending: boolean;
  onOpenTask: (id: string) => void;
};

function PageHeader({ title, lead, actions }: { title: string; lead: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{lead}</p>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

/* ================= Overview ================= */

export function OverviewView({ state, tasks, loading, onViewTasks, onViewAssistants, ...actions }: Actions & { state: AppState; tasks: Task[]; loading: boolean; onViewTasks: () => void; onViewAssistants: () => void }) {
  const assistants = state.providers.filter((provider) => !isDemoProvider(provider));
  const readyAssistants = assistants.filter((provider) => provider.available);
  const finished = tasks.filter((task) => task.status === 'completed');
  const active = tasks.filter(isActive);

  const steps = [
    {
      title: 'Choose a project',
      body: 'Point Crew Desk at a folder on this computer that uses Git.',
      done: state.projects.length > 0,
      status: state.projects.length ? `${state.projects.length} ${state.projects.length === 1 ? 'project' : 'projects'} added` : 'No projects yet',
      action: <button type="button" className="link-button" onClick={actions.onAddProject}>Add a project <ArrowRight size={14} aria-hidden="true" /></button>,
    },
    {
      title: 'Tell an assistant what to do',
      body: 'Write instructions in plain words and pick an AI assistant.',
      done: tasks.some((task) => !isDemoTask(task) && task.source !== 'imported'),
      status: readyAssistants.length ? `${readyAssistants.length} ${readyAssistants.length === 1 ? 'assistant' : 'assistants'} installed or set up` : 'No assistant set up yet',
      action: readyAssistants.length
        ? <button type="button" className="link-button" onClick={actions.onNewTask}>Start a task <ArrowRight size={14} aria-hidden="true" /></button>
        : <button type="button" className="link-button" onClick={onViewAssistants}>Set up an assistant <ArrowRight size={14} aria-hidden="true" /></button>,
    },
    {
      title: 'Review its work',
      body: 'Read its answer, follow its activity and see exactly which files changed.',
      done: false,
      status: active.length ? `${active.length} in progress` : finished.length ? `${finished.length} finished ${finished.length === 1 ? 'task' : 'tasks'}` : 'Nothing to review yet',
      action: finished[0]
        ? <button type="button" className="link-button" onClick={() => actions.onOpenTask(finished[0].id)}>Review the latest <ArrowRight size={14} aria-hidden="true" /></button>
        : null,
    },
  ];
  const nextIndex = steps.findIndex((step) => !step.done);

  return (
    <div className="page">
      <section className="intro panel">
        <div className="intro-copy">
          <p className="eyebrow">Your AI task desk</p>
          <h1>Hand a coding task to an AI assistant, then check its work.</h1>
          <p>
            Crew Desk runs on this computer. You pick one of your projects and describe what you need. An assistant works on a
            separate copy, so your original files stay as they are. When it’s done you can read its answer and see every file it changed.
          </p>
          <p className="intro-note">
            Assistants run on your own Claude subscription, or on your own DeepSeek or Kimi key for low-cost work.
          </p>
        </div>
        <div className="intro-actions">
          <button type="button" className="button button-primary button-large" onClick={actions.onNewTask}>
            <Plus size={18} aria-hidden="true" />
            New task
          </button>
          <DemoAction onDemo={actions.onDemo} pending={actions.demoPending} />
        </div>
      </section>

      <section aria-labelledby="flow-title">
        <h2 id="flow-title" className="section-title">How it works</h2>
        <ol className="steps">
          {steps.map((step, index) => (
            <li key={step.title} className={`step${step.done ? ' is-done' : ''}${index === nextIndex ? ' is-next' : ''}`}>
              <div className="step-top">
                <span className="step-number" aria-hidden="true">{step.done ? <Check size={16} /> : index + 1}</span>
                {index === nextIndex && <span className="next-tag">Next step</span>}
              </div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
              <div className="step-foot">
                <span className="step-status">{step.status}</span>
                {step.action}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <div className="overview-grid">
        <section className="panel" aria-labelledby="recent-title">
          <div className="panel-head">
            <h2 id="recent-title">Recent tasks</h2>
            {tasks.length > 0 && <button type="button" className="link-button" onClick={onViewTasks}>View all {tasks.length} <ArrowRight size={14} aria-hidden="true" /></button>}
          </div>
          {loading && !tasks.length ? (
            <p className="quiet-note"><LoaderCircle size={16} className="spin" aria-hidden="true" />Loading tasks…</p>
          ) : tasks.length ? (
            <ul className="task-list">
              {tasks.slice(0, 5).map((task) => <TaskRow key={task.id} task={task} projects={state.projects} providers={state.providers} onOpen={actions.onOpenTask} />)}
            </ul>
          ) : (
            <EmptyState icon={<ClipboardList size={20} />} title="No tasks yet">
              Start your first task, or try the free demo to see what a finished task looks like.
            </EmptyState>
          )}
        </section>

        <div className="side-stack">
          <section className="panel" aria-labelledby="assistants-title">
            <div className="panel-head">
              <h2 id="assistants-title">AI assistants</h2>
              <button type="button" className="link-button" onClick={onViewAssistants}>Details <ArrowRight size={14} aria-hidden="true" /></button>
            </div>
            {state.providers.length ? (
              <ul className="mini-list">
                {state.providers.map((provider) => (
                  <li key={provider.id}>
                    <span className="mini-name">{isDemoProvider(provider) ? 'Practice demo' : provider.name}</span>
                    <ReadinessBadge provider={provider} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="quiet-note">{loading ? 'Checking…' : 'The server has not reported any assistants.'}</p>
            )}
          </section>

          <section className="panel" aria-labelledby="projects-title">
            <div className="panel-head">
              <h2 id="projects-title">Projects</h2>
              <button type="button" className="link-button" onClick={actions.onAddProject}><FolderPlus size={15} aria-hidden="true" />Add</button>
            </div>
            {state.projects.length ? <ProjectList projects={state.projects} /> : <p className="quiet-note">No projects yet. Add a folder that uses Git to get started.</p>}
          </section>
        </div>
      </div>
    </div>
  );
}

function ProjectList({ projects }: { projects: Project[] }) {
  return (
    <ul className="project-list">
      {projects.map((project) => (
        <li key={project.id}>
          <FolderGit2 size={17} aria-hidden="true" />
          <span>
            <strong>{project.name}</strong>
            <span className="path-text" title={project.path}>{project.path}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ================= Tasks ================= */

type Filter = 'all' | 'active' | 'completed' | 'problem' | 'cancelled';
const FILTERS: Array<{ id: Filter; label: string; match: (task: Task) => boolean }> = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'active', label: 'In progress', match: isActive },
  { id: 'completed', label: 'Done', match: (task) => task.status === 'completed' },
  { id: 'problem', label: 'Failed', match: (task) => task.status === 'failed' || task.status === 'interrupted' },
  { id: 'cancelled', label: 'Stopped', match: (task) => task.status === 'cancelled' },
];

export function TasksView({ state, tasks, loading, selected, onCloseTask, onCancel, ...actions }: Actions & { state: AppState; tasks: Task[]; loading: boolean; selected: Task | null; onCloseTask: () => void; onCancel: (task: Task) => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((item) => [item.id, tasks.filter(item.match).length])) as Record<Filter, number>, [tasks]);
  const needle = query.trim().toLowerCase();
  const visible = tasks.filter((task) => FILTERS.find((item) => item.id === filter)!.match(task) && (!needle || task.title.toLowerCase().includes(needle) || task.prompt.toLowerCase().includes(needle)));

  return (
    <div className="page">
      <PageHeader
        title="Tasks"
        lead="Everything you’ve asked an assistant to do, newest first. Open a task to read its answer and review file changes."
        actions={<>
          <DemoAction onDemo={actions.onDemo} pending={actions.demoPending} variant="quiet" />
          <button type="button" className="button button-primary" onClick={actions.onNewTask}><Plus size={16} aria-hidden="true" />New task</button>
        </>}
      />

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Filter tasks by status">
          {FILTERS.map((item) => (
            <button key={item.id} type="button" aria-pressed={filter === item.id} className={filter === item.id ? 'is-active' : undefined} onClick={() => setFilter(item.id)}>
              {item.label}<span className="count">{counts[item.id]}</span>
            </button>
          ))}
        </div>
        <label className="search">
          <Search size={16} aria-hidden="true" />
          <span className="visually-hidden">Search tasks</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tasks" />
        </label>
      </div>

      <div className={`tasks-layout${selected ? ' has-selection' : ''}`}>
        <section className="panel tasks-list-panel" aria-label="Task list">
          {loading && !tasks.length ? (
            <p className="quiet-note"><LoaderCircle size={16} className="spin" aria-hidden="true" />Loading tasks…</p>
          ) : visible.length ? (
            <ul className="task-list">
              {visible.map((task) => (
                <TaskRow key={task.id} task={task} projects={state.projects} providers={state.providers} selected={task.id === selected?.id} showPreview={!selected} onOpen={actions.onOpenTask} onCancel={onCancel} />
              ))}
            </ul>
          ) : tasks.length ? (
            <EmptyState icon={<Search size={20} />} title="No tasks match" action={<button type="button" className="link-button" onClick={() => { setFilter('all'); setQuery(''); }}>Show all tasks</button>}>
              Try a different filter or search.
            </EmptyState>
          ) : (
            <EmptyState icon={<ClipboardList size={20} />} title="No tasks yet" action={<button type="button" className="button button-primary button-small" onClick={actions.onNewTask}><Plus size={15} aria-hidden="true" />New task</button>}>
              Start a task for one of your projects, or try the free demo first.
            </EmptyState>
          )}
        </section>
        {selected && <TaskDetail task={selected} projects={state.projects} providers={state.providers} onClose={onCloseTask} onCancel={onCancel} />}
      </div>
    </div>
  );
}

/* ================= AI assistants ================= */

export function AssistantsView({ providers, budget, online, loading, onRefresh, onDemo, demoPending }: { providers: Provider[]; budget?: BudgetSummary; online: boolean; loading: boolean; onRefresh: () => void; onDemo: () => void; demoPending: boolean }) {
  return (
    <div className="page">
      <PageHeader
        title="AI assistants"
        lead="The assistants this computer can use for tasks. Starting a task tests whether your sign-in or access key works. Check your AI account for the remaining balance."
        actions={<button type="button" className="button button-secondary" onClick={onRefresh}><RefreshCw size={15} aria-hidden="true" />Check again</button>}
      />
      {!online && !loading ? (
        <EmptyState icon={<Bot size={20} />} title="Can’t check assistants right now">
          The Crew Desk server isn’t reachable, so readiness is unknown. Start the server and this page updates on its own.
        </EmptyState>
      ) : !providers.length ? (
        <p className="quiet-note">{loading ? 'Checking assistants…' : 'The server has not reported any assistants.'}</p>
      ) : (
        <div className="assistant-grid">
          {providers.map((provider) => <AssistantCard key={provider.id} provider={provider} budget={budget?.providers[provider.id]} onDemo={onDemo} demoPending={demoPending} />)}
        </div>
      )}
      {budget && <BudgetPanel budget={budget} />}
      <p className="footnote">
        <ShieldCheck size={16} aria-hidden="true" />
        Access keys belong in the server’s <code>.env.local</code> file, never in this page. Usage and cost are shown per task only when the assistant reports them; otherwise they stay “unknown”.
      </p>
    </div>
  );
}

function AssistantCard({ provider, budget, onDemo, demoPending }: { provider: Provider; budget?: BudgetProvider; onDemo: () => void; demoPending: boolean }) {
  const info = readiness(provider);
  const demo = isDemoProvider(provider);
  const setup = SETUP_STEPS[provider.id];
  const needsSetup = !provider.available;
  return (
    <article className={`panel assistant-card${demo ? ' is-demo' : ''}`}>
      <div className="assistant-head">
        <span className="assistant-icon" aria-hidden="true">{demo ? <FlaskConical size={20} /> : <Bot size={20} />}</span>
        <div>
          <h2>{demo ? 'Practice demo' : provider.name}</h2>
          <Badge tone={info.tone}>{info.label}</Badge>
        </div>
      </div>
      <p>{info.explain}</p>
      <dl className="facts facts-compact">
        <div className="fact"><dt>Paid through</dt><dd>{demo ? 'Nothing (free)' : provider.billing ?? 'Unknown'}</dd></div>
        <div className="fact"><dt>Usage so far</dt><dd>{demo ? 'None' : budget ? `${formatUsd(budget.settledUsd)} settled · ${formatUsd(budget.remainingUsd)} of ${formatUsd(budget.allocationUsd)} left` : provider.id === 'claude' ? 'Counted by your Claude plan, not here' : 'Unknown until a task reports it'}</dd></div>
        {budget && <div className="fact"><dt>Paid tasks</dt><dd>{budget.laneOpen ? 'Accepting tasks (one at a time)' : `Paused: ${budget.laneReason}`}</dd></div>}
      </dl>
      {demo && <DemoAction onDemo={onDemo} pending={demoPending} />}
      {!demo && setup && (
        <details className="disclosure" open={needsSetup}>
          <summary><Wrench size={15} aria-hidden="true" />How to set up</summary>
          <div className="disclosure-body">
            <ol className="plain-steps">{setup.steps.map((step) => <li key={step}>{step}</li>)}</ol>
            {setup.code && <code className="code-chip">{setup.code}</code>}
          </div>
        </details>
      )}
      <details className="disclosure">
        <summary>Technical details</summary>
        <div className="disclosure-body">
          <dl className="tech-list">
            <div><dt>ID</dt><dd>{provider.id}</dd></div>
            <div><dt>Model</dt><dd>{provider.model ?? 'Claude Code default'}</dd></div>
            {provider.endpoint && <div><dt>Endpoint</dt><dd>{provider.endpoint}</dd></div>}
            <div><dt>Server status</dt><dd>{provider.status}</dd></div>
            {provider.detail && <div><dt>Server note</dt><dd>{provider.detail}</dd></div>}
          </dl>
        </div>
      </details>
    </article>
  );
}

/* ================= Build budget ================= */

function BudgetPanel({ budget }: { budget: BudgetSummary }) {
  const entries = Object.entries(budget.providers);
  if (!entries.length) return null;
  return (
    <section className="panel budget-panel" aria-labelledby="budget-title">
      <div className="panel-heading">
        <h2 id="budget-title">Build budget</h2>
        <p className="muted small">Separate allocations for this build ({budget.build.allocationSource}). {budget.costBasis}</p>
      </div>
      <div className="budget-grid">
        {entries.map(([id, lane]) => <BudgetLane key={id} id={id} lane={lane} />)}
      </div>
      <p className="muted small">Uncertain amounts are tasks whose charge could not be confirmed (for example, stopped or interrupted). They stay counted until reconciled with the provider’s usage page or balance.</p>
    </section>
  );
}

function BudgetLane({ id, lane }: { id: string; lane: BudgetProvider }) {
  const pct = (value: number) => lane.allocationUsd > 0 ? Math.min(100, Math.max(0, (value / lane.allocationUsd) * 100)) : 0;
  const balance = lane.lastBalance;
  const balanceText = !balance ? 'Not checked yet' : balance.ok === false ? `Check failed ${balance.httpStatus ? `(HTTP ${balance.httpStatus})` : ''} · ${formatWhen(balance.at)}` : `${(balance.balances ?? []).map((b) => `${b.total ?? '?'} ${b.currency}`).join(', ') || (balance.amount != null ? `${balance.amount} ${balance.currency}` : 'recorded')} · ${formatWhen(balance.at)}`;
  return (
    <article className="budget-lane" aria-label={`${id} budget`}>
      <header>
        <h3>{id === 'deepseek' ? 'DeepSeek' : id === 'kimi' ? 'Kimi' : id}</h3>
        <Badge tone={lane.laneOpen ? 'success' : 'danger'}>{lane.laneOpen ? 'Open' : 'Paused'}</Badge>
      </header>
      <p className="budget-remaining"><strong>{formatUsd(lane.remainingUsd)}</strong> left of {formatUsd(lane.allocationUsd)}</p>
      <div className="budget-bar" role="img" aria-label={`Settled ${formatUsd(lane.settledUsd)}, reserved ${formatUsd(lane.reservedUsd)}, uncertain ${formatUsd(lane.uncertainUsd)}, remaining ${formatUsd(lane.remainingUsd)}`}>
        <span className="seg-settled" style={{ width: `${pct(lane.settledUsd)}%` }} />
        <span className="seg-reserved" style={{ width: `${pct(lane.reservedUsd)}%` }} />
        <span className="seg-uncertain" style={{ width: `${pct(lane.uncertainUsd)}%` }} />
      </div>
      <dl className="tech-list">
        <div><dt><span className="swatch seg-settled" aria-hidden="true" />Settled</dt><dd>{formatUsd(lane.settledUsd)}</dd></div>
        <div><dt><span className="swatch seg-reserved" aria-hidden="true" />Reserved now</dt><dd>{formatUsd(lane.reservedUsd)}</dd></div>
        <div><dt><span className="swatch seg-uncertain" aria-hidden="true" />Uncertain</dt><dd>{formatUsd(lane.uncertainUsd)}</dd></div>
        <div><dt>Per-task limit</dt><dd>{lane.perTaskMaxUsd != null ? `${formatUsd(lane.perTaskMaxUsd)} (default target ${formatUsd(lane.defaultTargetUsd)})` : 'not set'}</dd></div>
        <div><dt>Prices</dt><dd>{lane.priceCards.length ? lane.priceCards.map((card) => `${card.model}: ${card.status}${card.checkedAt ? ` ${card.checkedAt}` : ''}`).join('; ') : 'none'}</dd></div>
        <div><dt>Provider balance</dt><dd>{balanceText}</dd></div>
      </dl>
      {!lane.laneOpen && lane.laneReason && <p className="small budget-reason">{lane.laneReason}</p>}
    </article>
  );
}

/* ================= How it works ================= */

export function GuideView({ onNewTask, onDemo, demoPending, maxConcurrent }: { onNewTask: () => void; onDemo: () => void; demoPending: boolean; maxConcurrent: number }) {
  return (
    <div className="page page-narrow">
      <PageHeader title="How it works" lead="Crew Desk lets you give coding tasks to AI assistants and review what they did, all on this computer." />

      <ol className="guide-steps">
        <li>
          <span className="step-number" aria-hidden="true">1</span>
          <div>
            <h2>Choose a project</h2>
            <p>A project is a folder on this computer that uses Git (a tool that saves versions of files). Crew Desk never edits that folder directly. For each task it makes a <strong>separate working copy</strong> from the project’s last saved version (commit), taken when you added the project. Anything you haven’t committed isn’t included.</p>
          </div>
        </li>
        <li>
          <span className="step-number" aria-hidden="true">2</span>
          <div>
            <h2>Tell an assistant what to do</h2>
            <p>Give the task a name, write instructions in plain words, and pick an AI assistant. Then choose what it may do:</p>
            <ul className="mode-list">
              <li><Eye size={16} aria-hidden="true" /><span><strong>Review files</strong>: it can read and search, but not change anything.</span></li>
              <li><PencilLine size={16} aria-hidden="true" /><span><strong>Make changes in a separate copy</strong>: it can edit files and run commands in its copy. Commands run on this computer, so only use projects you trust.</span></li>
            </ul>
          </div>
        </li>
        <li>
          <span className="step-number" aria-hidden="true">3</span>
          <div>
            <h2>Review its work</h2>
            <p>Open the task to see three things: the <strong>Result</strong> (the assistant’s answer), the <strong>Activity</strong> (what happened, step by step) and <strong>File changes</strong> (exactly which lines were added or removed). Nothing is copied back into your project automatically; you decide what to keep.</p>
          </div>
        </li>
      </ol>

      <section className="panel guide-demo">
        <div>
          <h2>Not sure yet? Try the demo.</h2>
          <p>The demo makes a small, pre-written change to a sample project and runs its tests, so you can see a finished task end to end. It is labelled “Demo” everywhere it appears.</p>
        </div>
        <div className="guide-demo-actions">
          <DemoAction onDemo={onDemo} pending={demoPending} />
          <button type="button" className="button button-quiet" onClick={onNewTask}><Plus size={16} aria-hidden="true" />New task</button>
        </div>
      </section>

      <section className="faq">
        <h2 className="section-title">Good to know</h2>
        <details className="disclosure">
          <summary>Which assistant should I pick?</summary>
          <div className="disclosure-body"><p>DeepSeek for routine, clearly described tasks: it is the cheapest. Kimi for harder work that spans several files. Claude when you would rather use your subscription than spend API money. The step-by-step guide is SOP.md in the Crew Desk folder.</p></div>
        </details>
        <details className="disclosure">
          <summary>Does it cost money?</summary>
          <div className="disclosure-body"><p>The demo is free. Real assistants use your own Claude subscription or API account. Reported cost estimates are not bills; check your account for actual charges. Advanced settings lets you request a budget target, which is not a guaranteed billing cap.</p></div>
        </details>
        <details className="disclosure">
          <summary>How many tasks run at once?</summary>
          <div className="disclosure-body"><p>This server runs up to {maxConcurrent} at a time. Extra tasks wait in line (“Waiting to start”) and begin automatically. You can stop any task that is waiting or working.</p></div>
        </details>
        <details className="disclosure">
          <summary>Advanced: using Crew Desk from Codex or the command line</summary>
          <div className="disclosure-body">
            <p>The same task list is available through a command-line tool (<code>npm run crew</code>) and an MCP server (<code>npm run mcp</code>). Tasks created there appear here, and vice versa. In technical terms a task is a “run”, instructions are the “prompt”, an assistant is a “provider”, and the separate working copy is a Git “worktree”. A worktree keeps files apart; it is not a security sandbox.</p>
          </div>
        </details>
      </section>
    </div>
  );
}
