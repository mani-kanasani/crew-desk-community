import { useCallback, useEffect, useMemo, useState } from 'react';

import { Bot, Check, ChevronRight, CircleAlert, CircleHelp, ClipboardList, LayoutDashboard, Menu, Plus, X, type LucideIcon } from 'lucide-react';
import { ProjectDialog, TaskDialog } from './dialogs';
import { api, emptyState, errorText, isActive, newestFirst, type AppState, type Project, type Task, type TaskPayload } from './lib';
import { AssistantsView, GuideView, OverviewView, TasksView } from './views';
import './styles.css';

type View = 'overview' | 'tasks' | 'assistants' | 'guide';

const NAV: Array<{ id: View; label: string; icon: LucideIcon }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'tasks', label: 'Tasks', icon: ClipboardList },
  { id: 'assistants', label: 'AI assistants', icon: Bot },
  { id: 'guide', label: 'How it works', icon: CircleHelp },
];

const NARROW_QUERY = '(max-width: 1040px)';

function App() {
  const [state, setState] = useState<AppState>(emptyState);
  const [online, setOnline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('overview');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [taskDialog, setTaskDialog] = useState(false);
  const [projectDialog, setProjectDialog] = useState(false);
  const [addedProjectId, setAddedProjectId] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [demoPending, setDemoPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api<AppState>('/api/state');
      setState({ ...emptyState, ...next, settings: { ...emptyState.settings, ...next.settings } });
      setOnline(true);
    } catch {
      setOnline(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.tone === 'error' ? 8000 : 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!navOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setNavOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [navOpen]);

  const tasks = useMemo(() => newestFirst(state.runs), [state.runs]);
  const selected = tasks.find((task) => task.id === selectedId) ?? null;
  const activeCount = tasks.filter(isActive).length;
  const workingCount = tasks.filter(task => task.status === 'running').length;
  const waitingCount = tasks.filter(task => task.status === 'queued').length;

  const go = (next: View) => {
    setView(next);
    setNavOpen(false);
    if (next !== 'tasks') setSelectedId(null);
    window.scrollTo({ top: 0 });
  };

  const openTask = (id: string) => {
    setSelectedId(id);
    setView('tasks');
    setNavOpen(false);
    // On narrow screens the detail stacks above the list, so bring it into view.
    if (window.matchMedia(NARROW_QUERY).matches) window.scrollTo({ top: 0 });
  };

  const notify = (tone: 'error' | 'success', message: string) => setNotice({ tone, message });

  const createTask = async (payload: TaskPayload) => {
    try {
      const response = await api<{ run: Task }>('/api/runs', { method: 'POST', body: JSON.stringify(payload) });
      setTaskDialog(false);
      notify('success', response.run.status === 'queued' ? 'Task is waiting to start. Its status updates automatically.' : 'Task started. Its status updates here automatically.');
      await load();
      openTask(response.run.id);
      return true;
    } catch (error) {
      notify('error', errorText(error, 'Could not start the task.'));
      return false;
    }
  };

  const startDemo = async () => {
    setDemoPending(true);
    try {
      const response = await api<{ run: Task }>('/api/demo', { method: 'POST', body: JSON.stringify({}) });
      notify('success', 'Demo started. Practice only: no AI or credits used.');
      await load();
      openTask(response.run.id);
    } catch (error) {
      notify('error', errorText(error, 'Could not start the demo.'));
    } finally {
      setDemoPending(false);
    }
  };

  const addProject = async (path: string, name: string) => {
    try {
      const response = await api<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify({ path, name: name || undefined }) });
      setProjectDialog(false);
      setAddedProjectId(response.project.id);
      notify('success', `Added ${response.project.name}.`);
      await load();
      return true;
    } catch (error) {
      notify('error', errorText(error, 'Could not add the project.'));
      return false;
    }
  };

  const cancelTask = async (task: Task) => {
    try {
      await api<{ run: Task }>(`/api/runs/${encodeURIComponent(task.id)}/cancel`, { method: 'POST', body: JSON.stringify({}) });
      notify('success', `Stopping “${task.title}”.`);
      await load();
    } catch (error) {
      notify('error', errorText(error, 'Could not stop this task.'));
    }
  };

  const shared = {
    onNewTask: () => setTaskDialog(true),
    onAddProject: () => setProjectDialog(true),
    onDemo: () => void startDemo(),
    demoPending,
    onOpenTask: openTask,
  };
  const currentLabel = NAV.find((item) => item.id === view)?.label ?? '';

  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to content</a>

      {navOpen && <div className="scrim" aria-hidden="true" onClick={() => setNavOpen(false)} />}
      <aside id="sidebar" className={`sidebar${navOpen ? ' is-open' : ''}`} aria-label="Main navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">CD</span>
          <span>
            <strong>Crew Desk</strong>
            <small>AI task desk</small>
          </span>
          <button type="button" className="icon-button nav-close" aria-label="Close menu" onClick={() => setNavOpen(false)}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <nav className="nav">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" className={`nav-item${view === id ? ' is-active' : ''}`} aria-current={view === id ? 'page' : undefined} onClick={() => go(id)}>
              <Icon size={18} aria-hidden="true" />
              <span>{label}</span>
              {id === 'tasks' && activeCount > 0 && <span className="nav-count" aria-label={`${activeCount} in progress`}>{activeCount}</span>}
            </button>
          ))}
        </nav>
        <button type="button" className="button button-primary sidebar-cta" onClick={() => { setNavOpen(false); setTaskDialog(true); }}>
          <Plus size={17} aria-hidden="true" />
          New task
        </button>
        <div className="sidebar-foot">
          <span className={`conn-dot${online ? ' is-on' : ''}`} aria-hidden="true" />
          <span>{loading ? 'Connecting…' : online ? 'Connected to the Crew Desk server on this computer' : 'Can’t reach the Crew Desk server'}</span>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <button type="button" className="icon-button menu-button" aria-label="Open menu" aria-controls="sidebar" aria-expanded={navOpen} onClick={() => setNavOpen(true)}>
            <Menu size={20} aria-hidden="true" />
          </button>
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <span className="crumb-root">Crew Desk</span>
            <ChevronRight size={14} aria-hidden="true" className="crumb-root" />
            {selected && view === 'tasks' ? (
              <>
                <button type="button" className="crumb-link" onClick={() => setSelectedId(null)}>{currentLabel}</button>
                <ChevronRight size={14} aria-hidden="true" />
                <strong className="crumb-current" aria-current="page">{selected.title}</strong>
              </>
            ) : (
              <strong className="crumb-current" aria-current="page">{currentLabel}</strong>
            )}
          </nav>
          <div className="topbar-actions">
            {activeCount > 0 && <span className="working-pill">{workingCount} working · {waitingCount} waiting</span>}
            <button type="button" className="button button-primary button-small" onClick={() => setTaskDialog(true)}>
              <Plus size={16} aria-hidden="true" />
              <span>New task</span>
            </button>
          </div>
        </header>

        {!online && !loading && (
          <div className="offline-banner" role="alert">
            <CircleAlert size={18} aria-hidden="true" />
            <span>
              <strong>Can’t reach the Crew Desk server.</strong> Start it with <code>npm start</code> in the harness folder. This page reconnects on its own.
            </span>
          </div>
        )}

        <main id="main" className="content">
          {view === 'overview' && <OverviewView {...shared} state={state} tasks={tasks} loading={loading} onViewTasks={() => go('tasks')} onViewAssistants={() => go('assistants')} />}
          {view === 'tasks' && <TasksView {...shared} state={state} tasks={tasks} loading={loading} selected={selected} onCloseTask={() => setSelectedId(null)} onCancel={(task) => void cancelTask(task)} />}
          {view === 'assistants' && <AssistantsView providers={state.providers} budget={state.budget} online={online} loading={loading} onRefresh={() => void load()} onDemo={shared.onDemo} demoPending={demoPending} />}
          {view === 'guide' && <GuideView onNewTask={shared.onNewTask} onDemo={shared.onDemo} demoPending={demoPending} maxConcurrent={state.settings.maxConcurrent} />}
        </main>
      </div>

      {notice && (
        <div className={`toast toast-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          {notice.tone === 'error' ? <CircleAlert size={18} aria-hidden="true" /> : <Check size={18} aria-hidden="true" />}
          <span>{notice.message}</span>
          <button type="button" aria-label="Dismiss message" onClick={() => setNotice(null)}><X size={16} aria-hidden="true" /></button>
        </div>
      )}

      {taskDialog && (
        <TaskDialog
          providers={state.providers}
          projects={state.projects}
          preferredProjectId={addedProjectId}
          onClose={() => setTaskDialog(false)}
          onSubmit={createTask}
          onAddProject={() => setProjectDialog(true)}
          onOpenAssistants={() => { setTaskDialog(false); go('assistants'); }}
        />
      )}
      {projectDialog && <ProjectDialog onClose={() => setProjectDialog(false)} onSubmit={addProject} />}
    </div>
  );
}

export default App;


