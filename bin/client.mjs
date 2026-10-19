export function serverUrl() {
  const url = new URL(process.env.HARNESS_URL || 'http://127.0.0.1:4317');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('HARNESS_URL must be an HTTP loopback address.');
  }
  return url.origin;
}

export async function request(path, body) {
  let response;
  try {
    response = await fetch(`${serverUrl()}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw new Error(`Crew Desk is not reachable. Start it with npm start in the Crew Desk folder. ${error.message}`);
  }
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

export function summarizeRun(run) {
  if (!run) return null;
  const { logs, diff, prompt, result, ...summary } = run;
  if (summary.scope?.changedFiles?.length > 40) summary.scope = { ...summary.scope, changedFiles: [...summary.scope.changedFiles.slice(0, 40), `…${summary.scope.changedFiles.length - 40} more`] };
  return { ...summary, logCount: logs?.length || 0, hasDiff: Boolean(diff), hasResult: Boolean(result) };
}

export async function compactState() {
  const state = await request('/api/state');
  return { ...state, runs: state.runs.map(summarizeRun) };
}
