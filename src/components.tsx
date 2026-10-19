import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleCheck, CircleX, Clock3, FlaskConical, LoaderCircle, Square, CircleAlert, X, type LucideIcon } from 'lucide-react';
import { DEMO_PROVIDER, formatWhen, isActive, isDemoTask, projectName, providerName, readiness, statusInfo, type Project, type Provider, type Task, type Tone } from './lib';

const STATUS_ICONS: Record<string, LucideIcon> = {
  queued: Clock3,
  running: LoaderCircle,
  completed: CircleCheck,
  failed: CircleX,
  cancelled: Square,
  interrupted: CircleAlert,
};

export function StatusBadge({ status }: { status: string }) {
  const info = statusInfo(status);
  const Icon = STATUS_ICONS[status] ?? Clock3;
  return (
    <span className={`badge tone-${info.tone}`}>
      <Icon size={14} className={status === 'running' ? 'spin' : undefined} aria-hidden="true" />
      {info.label}
    </span>
  );
}

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge tone-${tone}`}>{children}</span>;
}

export function ReadinessBadge({ provider }: { provider: Provider }) {
  const info = readiness(provider);
  return <Badge tone={info.tone}>{info.label}</Badge>;
}

export function DemoTag() {
  return (
    <span className="demo-tag" title="Practice only. No AI or credits used.">
      <FlaskConical size={12} aria-hidden="true" />
      Demo
    </span>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden="true">{icon}</div>
      <div className="empty-copy">
        <strong>{title}</strong>
        {children && <p>{children}</p>}
        {action && <div className="empty-action">{action}</div>}
      </div>
    </div>
  );
}

export function DemoAction({ onDemo, pending, variant = 'secondary' }: { onDemo: () => void; pending: boolean; variant?: 'secondary' | 'quiet' }) {
  return (
    <div className="demo-action">
      <button type="button" className={`button button-${variant}`} onClick={onDemo} disabled={pending}>
        {pending ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <FlaskConical size={16} aria-hidden="true" />}
        {pending ? 'Starting demo…' : 'Try a free demo'}
      </button>
      <small>Practice only. No AI or credits used.</small>
    </div>
  );
}

type TaskRowProps = {
  task: Task;
  projects: Project[];
  providers: Provider[];
  selected?: boolean;
  showPreview?: boolean;
  onOpen: (id: string) => void;
  onCancel?: (task: Task) => void;
};

/** One task in a list. The open button and the stop button are siblings, never nested. */
export function TaskRow({ task, projects, providers, selected = false, showPreview = false, onOpen, onCancel }: TaskRowProps) {
  const tone = statusInfo(task.status).tone;
  return (
    <li className={`task-row${selected ? ' is-selected' : ''}`}>
      <button type="button" className="task-row-main" onClick={() => onOpen(task.id)} aria-current={selected ? 'true' : undefined}>
        <span className={`status-dot tone-${tone}`} aria-hidden="true" />
        <span className="task-row-text">
          <span className="task-row-title">
            <strong>{task.title}</strong>
            {isDemoTask(task) && <DemoTag />}
            {task.source === 'imported' && <span className="demo-tag" title="Recorded outside Crew Desk and imported after completion">Imported</span>}
          </span>
          {showPreview && <span className="task-row-preview">{task.prompt}</span>}
          <span className="task-row-meta">
            {providerName(task.provider, providers)} · {projectName(task.projectId, projects)} · {formatWhen(task.createdAt)}
          </span>
        </span>
        <span className="task-row-status"><StatusBadge status={task.status} /></span>
      </button>
      {onCancel && isActive(task) && (
        <button type="button" className="task-row-stop" onClick={() => onCancel(task)} aria-label={`Stop task: ${task.title}`}>
          <Square size={12} aria-hidden="true" />
          Stop
        </button>
      )}
    </li>
  );
}

export function Field({ label, hint, htmlFor, children }: { label: string; hint?: ReactNode; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

/**
 * Modal shell. Focus moves in once on open (not on every parent re-render),
 * and Escape is handled on the dialog itself so stacked dialogs close one at a time.
 */
export function Dialog({ title, description, onClose, children, size = 'normal' }: { title: string; description?: ReactNode; onClose: () => void; children: ReactNode; size?: 'normal' | 'wide' }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [titleId] = useState(() => `dialog-${Math.random().toString(36).slice(2, 9)}`);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select');
    (first ?? ref.current)?.focus();
    return () => previous?.focus?.();
  }, []);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeRef.current(); }}>
      <div
        className={`modal modal-${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={ref}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); closeRef.current(); } }}
      >
        <header className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={() => closeRef.current()}>
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function isDemoProvider(provider: Provider): boolean {
  return provider.id === DEMO_PROVIDER;
}
