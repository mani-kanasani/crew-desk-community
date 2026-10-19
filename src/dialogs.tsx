import { useEffect, useState, type FormEvent } from 'react';
import { CircleAlert, Eye, FolderPlus, LoaderCircle, PencilLine, Play } from 'lucide-react';
import { Dialog, Field } from './components';
import { DEMO_PROVIDER, readiness, type Project, type Provider, type TaskPayload } from './lib';

type TaskDialogProps = {
  providers: Provider[];
  projects: Project[];
  preferredProjectId: string | null;
  onClose: () => void;
  onSubmit: (payload: TaskPayload) => Promise<boolean>;
  onAddProject: () => void;
  onOpenAssistants: () => void;
};

const MODES = [
  { id: 'read' as const, icon: Eye, title: 'Review files', body: 'The assistant can read and search files but cannot change them. Good for questions, reviews and plans.' },
  { id: 'edit' as const, icon: PencilLine, title: 'Make changes in a separate copy', body: 'The assistant can edit files and run commands inside its own copy. Your original folder is left as it is.' },
];

export function TaskDialog({ providers, projects, preferredProjectId, onClose, onSubmit, onAddProject, onOpenAssistants }: TaskDialogProps) {
  // The practice demo has its own button and sample project, so it is not offered here.
  const assistants = providers.filter((provider) => provider.id !== DEMO_PROVIDER);
  const firstReady = assistants.find((provider) => provider.available)?.id ?? '';

  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [provider, setProvider] = useState(firstReady);
  const [projectId, setProjectId] = useState(preferredProjectId ?? projects[0]?.id ?? '');
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [maxTurns, setMaxTurns] = useState('8');
  const [timeoutSeconds, setTimeoutSeconds] = useState('900');
  const [budgetUsd, setBudgetUsd] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  // State arrives by polling; fill in sensible defaults once it does.
  useEffect(() => { if (!provider && firstReady) setProvider(firstReady); }, [firstReady, provider]);
  useEffect(() => { if (!projectId && projects[0]) setProjectId(projects[0].id); }, [projects, projectId]);
  useEffect(() => { if (preferredProjectId) setProjectId(preferredProjectId); }, [preferredProjectId]);

  const selectedProvider = assistants.find((item) => item.id === provider);
  const selectedProject = projects.find((item) => item.id === projectId);
  const noAssistantReady = !firstReady;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !prompt.trim()) return setError('Add a short name and the instructions for the assistant.');
    if (!provider) return setError('Choose an AI assistant.');
    if (!projectId) return setError('Choose a project, or add one first.');
    const turns = Number(maxTurns);
    const timeout = Number(timeoutSeconds);
    if (!Number.isInteger(turns) || turns < 1 || turns > 100) return setError('Maximum steps must be a whole number from 1 to 100.');
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 7200) return setError('Time limit must be a whole number of seconds from 1 to 7200.');
    const budget = budgetUsd.trim() ? Number(budgetUsd) : undefined;
    if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0 || budget > 10000)) return setError('Spending limit must be more than $0 and at most $10,000, or left blank.');
    setError('');
    setPending(true);
    const ok = await onSubmit({ title: title.trim(), prompt: prompt.trim(), provider, projectId, mode, maxTurns: turns, timeoutSeconds: timeout, ...(budget !== undefined ? { budgetUsd: budget } : {}) });
    if (!ok) setPending(false);
  };

  return (
    <Dialog title="New task" description="Tell an AI assistant what to do in one of your projects. You can review everything it did afterwards." onClose={onClose} size="wide">
      <form className="modal-body form" onSubmit={submit} noValidate>
        <Field label="Task name" htmlFor="task-title" hint="A short name so you can find it later.">
          <input id="task-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Explain how sign-up works" maxLength={160} />
        </Field>

        <Field label="Instructions" htmlFor="task-prompt" hint="Write it as you would to a colleague: what to look at, what to do, and what a good answer looks like.">
          <textarea id="task-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={6} placeholder="e.g. Read the sign-up page and explain, step by step, what happens when someone creates an account. List anything that looks broken." />
        </Field>

        <div className="form-row">
          <Field
            label="AI assistant"
            htmlFor="task-provider"
            hint={selectedProvider ? readiness(selectedProvider).explain : noAssistantReady ? <>No assistant is set up yet. <button type="button" className="link-button" onClick={onOpenAssistants}>See how to set one up</button>.</> : undefined}
          >
            <select id="task-provider" value={provider} onChange={(event) => setProvider(event.target.value)}>
              <option value="">Choose an assistant…</option>
              {assistants.map((item) => (
                <option key={item.id} value={item.id} disabled={!item.available}>
                  {item.name}{item.available ? '' : ' (needs setup)'}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Project"
            htmlFor="task-project"
            hint={selectedProject ? <><span className="path-text">{selectedProject.path}</span></> : 'A folder on this computer that uses Git.'}
          >
            <div className="input-with-action">
              <select id="task-project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                <option value="">{projects.length ? 'Choose a project…' : 'No projects yet'}</option>
                {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <button type="button" className="button button-secondary" onClick={onAddProject}>
                <FolderPlus size={16} aria-hidden="true" />
                Add
              </button>
            </div>
          </Field>
        </div>

        <fieldset className="choice-group">
          <legend className="field-label">What may the assistant do?</legend>
          <div className="choice-grid">
            {MODES.map(({ id, icon: Icon, title: label, body }) => (
              <label key={id} className={`choice-card${mode === id ? ' is-checked' : ''}`}>
                <input type="radio" name="mode" value={id} checked={mode === id} onChange={() => setMode(id)} />
                <span className="choice-icon" aria-hidden="true"><Icon size={18} /></span>
                <span>
                  <strong>{label}</strong>
                  <small>{body}</small>
                </span>
              </label>
            ))}
          </div>
          <p className="field-hint">
            Either way, the assistant works in a separate copy made from the project’s <strong>last saved Git commit as of when you added it</strong>. Uncommitted changes, and commits made after adding it, are not included.
            {mode === 'edit' && ' Commands run on this computer, so only use projects you trust.'}
          </p>
        </fieldset>

        <details className="disclosure">
          <summary>Advanced settings</summary>
          <div className="disclosure-body form-row form-row-3">
            <Field label="Maximum steps" htmlFor="task-turns" hint="How many back-and-forth rounds the assistant may take before it stops (1–100).">
              <input id="task-turns" type="number" inputMode="numeric" min={1} max={100} value={maxTurns} onChange={(event) => setMaxTurns(event.target.value)} />
            </Field>
            <Field label="Time limit (seconds)" htmlFor="task-timeout" hint="The task is stopped if it runs longer than this (1–7200). 900 = 15 minutes.">
              <input id="task-timeout" type="number" inputMode="numeric" min={1} max={7200} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(event.target.value)} />
            </Field>
            <Field label="Budget target (USD)" htmlFor="task-budget" hint="Optional. Requests a spending limit from Claude Code. Actual charges depend on your AI account; this is not a guaranteed billing cap.">
              <input id="task-budget" type="number" inputMode="decimal" min={0} step="0.01" value={budgetUsd} onChange={(event) => setBudgetUsd(event.target.value)} placeholder="No limit" />
            </Field>
          </div>
        </details>

        {error && <p className="form-error" role="alert"><CircleAlert size={16} aria-hidden="true" />{error}</p>}

        <div className="modal-actions">
          <button type="button" className="button button-quiet" onClick={onClose}>Cancel</button>
          <button type="submit" className="button button-primary" disabled={pending || noAssistantReady || !projects.length}>
            {pending ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
            {pending ? 'Starting…' : 'Start task'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ProjectDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (path: string, name: string) => Promise<boolean> }) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!path.trim()) return setError('Enter the full folder path of a Git project on this computer.');
    setError('');
    setPending(true);
    const ok = await onSubmit(path.trim(), name.trim());
    if (!ok) setPending(false);
  };

  return (
    <Dialog title="Add a project" description="A project is a folder on this computer that uses Git. Crew Desk never edits it directly; tasks work in separate copies." onClose={onClose}>
      <form className="modal-body form" onSubmit={submit} noValidate>
        <Field label="Folder path" htmlFor="project-path" hint="The full path on the computer running Crew Desk. The folder needs at least one Git commit. Tasks start from the commit it is on right now; uncommitted changes are left out.">
          <input id="project-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="C:\Users\you\Projects\my-app" spellCheck={false} />
        </Field>
        <Field label="Display name (optional)" htmlFor="project-name" hint="Leave blank to use the folder name.">
          <input id="project-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="My app" />
        </Field>
        {error && <p className="form-error" role="alert"><CircleAlert size={16} aria-hidden="true" />{error}</p>}
        <div className="modal-actions">
          <button type="button" className="button button-quiet" onClick={onClose}>Cancel</button>
          <button type="submit" className="button button-primary" disabled={pending}>
            {pending ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <FolderPlus size={16} aria-hidden="true" />}
            {pending ? 'Adding…' : 'Add project'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
