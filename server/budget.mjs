// Persistent build-budget ledger for paid Crew Desk workers.
//
// Default allocations: US$5 DeepSeek and US$10 Kimi, cumulative across
// sessions, not transferable; change them with `crew allocation`. This ledger only
// constrains dispatch: it cannot stop a provider from charging for a call that
// is already in flight, so each reservation includes headroom for worst-case
// calls and uncertain outcomes keep their reservation until reconciled.
//
// Money is held as integer micro-dollars (1e-6 USD) to keep arithmetic exact.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { estimateCostUsd, worstCaseCallUsd, modelKey } from './usage.mjs';

export const DEFAULT_ALLOCATIONS_USD = { deepseek: 5, kimi: 10 };
export const PAID_PROVIDERS = Object.keys(DEFAULT_ALLOCATIONS_USD);

const ENTRY_STATUSES = ['reserved', 'settled', 'uncertain', 'released', 'reconciled'];

export function toMicros(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n)) throw new Error('amount must be a finite number');
  return Math.round(n * 1e6);
}

export function fromMicros(micros) { return micros == null ? null : Math.round(micros) / 1e6; }

async function atomicWriteJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temp, file);
}

function freshLedger(now, allocations) {
  return {
    version: 1,
    build: { id: 'my-build', createdAt: now, allocationSource: 'Crew Desk defaults (change with: node bin/crew.mjs allocation PROVIDER USD "reason")', note: 'Paid API allocations only; Claude subscription runs are not counted.' },
    providers: Object.fromEntries(Object.entries(allocations).map(([id, usd]) => [id, {
      allocationMicros: toMicros(usd), paused: false, pauseReason: null, pauseHistory: [], balances: [],
    }])),
    entries: [],
  };
}

/** Load the reviewed price file. Missing or malformed pricing pauses paid lanes. */
export async function loadPricing(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return { ok: true, pricing: parsed, file };
  } catch (error) {
    return { ok: false, pricing: {}, file, error: error.code === 'ENOENT' ? 'price file missing' : `price file unreadable: ${error.message}` };
  }
}

function validCard(card) {
  if (!card || card.status !== 'verified' || card.currency !== 'USD') return false;
  for (const key of ['inputPerMTok', 'outputPerMTok', 'contextWindowTokens']) if (!(Number.isFinite(card[key]) && card[key] > 0)) return false;
  for (const key of ['cacheReadPerMTok', 'cacheWritePerMTok']) if (card[key] != null && !(Number.isFinite(card[key]) && card[key] >= 0)) return false;
  return Array.isArray(card.sources) && card.sources.length > 0 && typeof card.checkedAt === 'string';
}

function policyFor(pricing, provider) {
  const policy = pricing?.[provider];
  if (!policy) return null;
  const ok = Number.isFinite(policy.perTaskMaxUsd) && policy.perTaskMaxUsd > 0
    && ['maxOutputTokensPerCall', 'headroomCalls', 'contextBoundTokens'].every((key) => Number.isInteger(policy[key]) && policy[key] > 0);
  if (policy.autoCompactWindowTokens != null && !(Number.isInteger(policy.autoCompactWindowTokens) && policy.autoCompactWindowTokens > 0 && policy.autoCompactWindowTokens <= policy.contextBoundTokens)) return null;
  return ok ? policy : null;
}

export function priceCardFor(pricing, provider, model) {
  const models = pricing?.[provider]?.models ?? {};
  const wanted = modelKey(model);
  for (const [id, card] of Object.entries(models)) {
    if (modelKey(id) === wanted || (card.aliases ?? []).some((alias) => modelKey(alias) === wanted)) return { id, card };
  }
  return null;
}

/** True when every reported model is the requested model or a declared alias. */
export function reportedModelsMatch(pricing, provider, requested, reported) {
  if (!reported.length) return null;
  const found = priceCardFor(pricing, provider, requested);
  const accepted = new Set([modelKey(requested), ...(found ? [modelKey(found.id), ...(found.card.aliases ?? []).map(modelKey), ...(found.card.reportedModelAliases ?? []).map(modelKey)] : [])]);
  return reported.every((model) => accepted.has(modelKey(model)));
}

export async function openBudgetLedger({ file, pricingFile, now = () => new Date().toISOString(), allocations = DEFAULT_ALLOCATIONS_USD }) {
  let data;
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // Never silently reset spending history.
      throw new Error(`Budget ledger ${file} is unreadable (${error.message}). Paid work stays blocked until it is repaired; it was not reset.`);
    }
    data = freshLedger(now(), allocations);
    await atomicWriteJson(file, data);
  }
  if (data.version !== 1 || !data.providers || !Array.isArray(data.entries)) throw new Error(`Budget ledger ${file} has an unsupported format; it was not reset.`);
  for (const [id, usd] of Object.entries(allocations)) {
    // New providers may be added; existing allocations are never overwritten.
    if (!data.providers[id]) data.providers[id] = { allocationMicros: toMicros(usd), paused: false, pauseReason: null, pauseHistory: [], balances: [] };
  }

  let priceState = pricingFile ? await loadPricing(pricingFile) : { ok: false, pricing: {}, error: 'no price file configured' };
  let lock = Promise.resolve();
  const withLock = (fn) => { const next = lock.then(fn, fn); lock = next.catch(() => {}); return next; };
  const persist = () => atomicWriteJson(file, data);
  const entryFor = (id) => data.entries.find((entry) => entry.id === id);

  function exposureMicros(entry) {
    if (entry.status === 'reserved') return entry.reservedMicros;
    if (entry.status === 'uncertain') return Math.max(entry.reservedMicros, entry.estimateMicros ?? 0);
    if (entry.status === 'settled' || entry.status === 'reconciled') return entry.settledMicros ?? 0;
    return 0;
  }

  function totals(provider) {
    const t = { settledMicros: 0, reservedMicros: 0, uncertainMicros: 0 };
    for (const entry of data.entries) {
      if (entry.provider !== provider) continue;
      if (entry.status === 'reserved') t.reservedMicros += exposureMicros(entry);
      else if (entry.status === 'uncertain') t.uncertainMicros += exposureMicros(entry);
      else if (entry.status === 'settled' || entry.status === 'reconciled') t.settledMicros += exposureMicros(entry);
    }
    const allocationMicros = data.providers[provider]?.allocationMicros ?? 0;
    return { ...t, allocationMicros, committedMicros: t.settledMicros + t.reservedMicros + t.uncertainMicros, remainingMicros: allocationMicros - t.settledMicros - t.reservedMicros - t.uncertainMicros };
  }

  function transition(entry, to, reason, at = now()) {
    if (!ENTRY_STATUSES.includes(to)) throw new Error(`invalid ledger status ${to}`);
    entry.history.push({ at, from: entry.status, to, reason });
    entry.status = to;
    entry.updatedAt = at;
    if (to !== 'reserved') entry.closedAt = entry.closedAt ?? at;
  }

  function laneState(provider) {
    const providerData = data.providers[provider];
    if (!providerData) return { open: false, reason: `${provider} has no build allocation` };
    if (providerData.paused) return { open: false, reason: `${provider} lane paused: ${providerData.pauseReason}` };
    if (!priceState.ok) return { open: false, reason: `${provider} lane paused: ${priceState.error}` };
    if (!policyFor(priceState.pricing, provider)) return { open: false, reason: `${provider} lane paused: no valid reservation policy in the price file` };
    return { open: true, reason: null };
  }

  return {
    file,
    get pricing() { return priceState.pricing; },

    async reloadPricing() { if (pricingFile) priceState = await loadPricing(pricingFile); return priceState; },

    laneState,

    summary() {
      const providers = {};
      for (const [id, providerData] of Object.entries(data.providers)) {
        const t = totals(id);
        const lane = laneState(id);
        const policy = policyFor(priceState.pricing, id);
        const cards = Object.entries(priceState.pricing?.[id]?.models ?? {}).map(([model, card]) => ({ model, status: validCard(card) ? 'verified' : (card.status || 'unverified'), checkedAt: card.checkedAt ?? null, sources: card.sources ?? [] }));
        providers[id] = {
          allocationUsd: fromMicros(t.allocationMicros),
          settledUsd: fromMicros(t.settledMicros),
          reservedUsd: fromMicros(t.reservedMicros),
          uncertainUsd: fromMicros(t.uncertainMicros),
          remainingUsd: fromMicros(t.remainingMicros),
          laneOpen: lane.open,
          laneReason: lane.reason,
          paused: providerData.paused,
          pauseReason: providerData.pauseReason,
          perTaskMaxUsd: policy?.perTaskMaxUsd ?? null,
          defaultTargetUsd: policy?.defaultTargetUsd ?? null,
          priceCards: cards,
          lastBalance: providerData.balances.at(-1) ?? null,
          baselineBalance: providerData.balances[0] ?? null,
          entries: data.entries.filter((entry) => entry.provider === id).length,
        };
      }
      return { build: data.build, providers, costBasis: 'Settled amounts are estimates from CLI-reported tokens × published rates unless reconciled against provider billing.', ledgerFile: file };
    },

    entries() { return data.entries.map((entry) => ({ ...entry, reservedUsd: fromMicros(entry.reservedMicros), estimateUsd: fromMicros(entry.estimateMicros), settledUsd: fromMicros(entry.settledMicros) })); },

    entry(id) { const entry = entryFor(id); return entry ? { ...entry, reservedUsd: fromMicros(entry.reservedMicros), estimateUsd: fromMicros(entry.estimateMicros), settledUsd: fromMicros(entry.settledMicros) } : null; },

    /** Atomically admit a paid run or explain the rejection. */
    reserve({ provider, runId, model, targetUsd }) {
      return withLock(async () => {
        const lane = laneState(provider);
        if (!lane.open) return { ok: false, reason: lane.reason };
        const found = priceCardFor(priceState.pricing, provider, model);
        if (!found || !validCard(found.card)) return { ok: false, reason: `${provider} lane paused for model ${model}: no verified USD price card with sources` };
        const policy = policyFor(priceState.pricing, provider);
        const target = Number(targetUsd);
        if (!(Number.isFinite(target) && target > 0)) return { ok: false, reason: 'A paid run needs a positive budgetUsd target.' };
        if (target > policy.perTaskMaxUsd) return { ok: false, reason: `budgetUsd ${target} exceeds the ${provider} per-task maximum of ${policy.perTaskMaxUsd} USD.` };
        // Reconciliation against provider balances was demonstrated on 2026-09-21,
        // so each provider may run one paid task at a time (the harness caps total concurrency at two).
        const active = data.entries.find((entry) => entry.status === 'reserved' && entry.provider === provider);
        if (active) return { ok: false, reason: `Paid run ${active.runId} still holds ${provider} reservation ${active.id}. One paid run per provider at a time.` };
        const targetMicros = toMicros(target);
        const contextTokens = Math.min(policy.contextBoundTokens, found.card.contextWindowTokens);
        const perCallMicros = toMicros(worstCaseCallUsd(found.card, policy.maxOutputTokensPerCall, contextTokens));
        const headroomMicros = perCallMicros * policy.headroomCalls;
        const reservedMicros = targetMicros + headroomMicros;
        const t = totals(provider);
        if (t.committedMicros + reservedMicros > t.allocationMicros) {
          return { ok: false, reason: `Rejected: ${provider} settled ${fromMicros(t.settledMicros)} + reserved ${fromMicros(t.reservedMicros)} + uncertain ${fromMicros(t.uncertainMicros)} + this reservation ${fromMicros(reservedMicros)} USD would exceed the ${fromMicros(t.allocationMicros)} USD allocation.` };
        }
        const at = now();
        const entry = {
          id: `bud_${randomUUID()}`, provider, runId, model, pricedModel: found.id, status: 'reserved',
          targetMicros, headroomMicros, reservedMicros, estimateMicros: null, settledMicros: null,
          basis: `target ${fromMicros(targetMicros)} + ${policy.headroomCalls} × worst-case call ${fromMicros(perCallMicros)} (${contextTokens} context tokens at the highest input rate + ${policy.maxOutputTokensPerCall} output tokens)`,
          pricing: { ...found.card }, maxOutputTokensPerCall: policy.maxOutputTokensPerCall,
          contextBoundTokens: contextTokens, autoCompactWindowTokens: policy.autoCompactWindowTokens ?? null,
          createdAt: at, updatedAt: at, dispatchedAt: null, closedAt: null,
          usage: null, outcome: null, reconciliation: null, history: [{ at, from: null, to: 'reserved', reason: 'admitted' }],
        };
        data.entries.push(entry);
        await persist();
        return { ok: true, entry: { ...entry } };
      });
    },

    /** Persist before spawning so a crash after this point is treated as possibly charged. */
    markDispatched(id) {
      return withLock(async () => {
        const entry = entryFor(id);
        if (!entry || entry.status !== 'reserved') return null;
        entry.dispatchedAt = now(); entry.updatedAt = entry.dispatchedAt;
        await persist();
        return { ...entry };
      });
    },

    /** Current in-flight estimate for the running guard; no persistence. */
    estimate(id, totalsSnapshot) {
      const entry = entryFor(id);
      if (!entry) return null;
      return estimateCostUsd(totalsSnapshot, entry.pricing);
    },

    /**
     * Close a reservation after the run ends.
     * neverStarted: the provider process demonstrably never started (no call possible).
     */
    close(id, { neverStarted = false, usage = null, outcome = null, modelsMatch = null, reason = null } = {}) {
      return withLock(async () => {
        const entry = entryFor(id);
        if (!entry || entry.status !== 'reserved') return entry ? { ...entry } : null;
        entry.outcome = outcome;
        entry.usage = usage;
        if (!entry.dispatchedAt || neverStarted) {
          transition(entry, 'released', reason || (entry.dispatchedAt ? 'provider process did not start' : 'run ended before dispatch'));
          await persist();
          return { ...entry };
        }
        const estimate = usage ? estimateCostUsd(usage.totals, entry.pricing) : null;
        entry.estimateMicros = estimate?.usd != null ? toMicros(estimate.usd) : null;
        const problems = [];
        if (!usage || usage.completeness !== 'reported') problems.push(`usage ${usage?.completeness ?? 'missing'}`);
        if (estimate && !estimate.complete) problems.push(`missing ${estimate.missing.join(', ')}`);
        if (modelsMatch === false) problems.push('reported model differs from the priced model');
        if (outcome?.code && ['timeout', 'cancelled', 'budget_stop', 'interrupted'].includes(outcome.code)) problems.push(`run ${outcome.code}`);
        if (problems.length) {
          transition(entry, 'uncertain', `${reason ? `${reason}; ` : ''}${problems.join('; ')}. Reservation retained until reconciled.`);
        } else {
          entry.settledMicros = entry.estimateMicros;
          transition(entry, 'settled', reason || 'CLI-reported session usage × published rates (estimate, not provider billing)');
        }
        await persist();
        return { ...entry };
      });
    },

    /** After a restart: undispatched reservations are released; dispatched ones become uncertain. */
    recoverAfterRestart() {
      return withLock(async () => {
        let changed = 0;
        for (const entry of data.entries) {
          if (entry.status !== 'reserved') continue;
          if (entry.dispatchedAt) transition(entry, 'uncertain', 'Server restarted while the run was active; any charge is unknown. Reservation retained until reconciled.');
          else transition(entry, 'released', 'Server restarted before the provider process was started.');
          changed += 1;
        }
        if (changed) await persist();
        return changed;
      });
    },

    /** Record an actual amount from provider usage/billing, with its source. */
    reconcile(id, { actualUsd, source, note }) {
      return withLock(async () => {
        const entry = entryFor(id);
        if (!entry) throw new Error('Ledger entry not found');
        if (!['settled', 'uncertain', 'reconciled'].includes(entry.status)) throw new Error(`Cannot reconcile a ${entry.status} entry`);
        if (typeof source !== 'string' || source.trim().length < 3) throw new Error('A reconciliation source is required (for example, the provider usage page and date).');
        if (!(Number(actualUsd) >= 0) || Object.is(Number(actualUsd), -0)) throw new Error('actualUsd must be a non-negative number');
        const actualMicros = toMicros(actualUsd);
        const at = now();
        entry.reconciliation = { actualMicros, source: source.trim().slice(0, 300), note: typeof note === 'string' ? note.slice(0, 1000) : null, at, previousStatus: entry.status, previousSettledMicros: entry.settledMicros };
        entry.settledMicros = actualMicros;
        transition(entry, 'reconciled', `Reconciled: ${entry.reconciliation.source}`, at);
        await persist();
        return { ...entry };
      });
    },

    /** Owner-directed allocation change. Never silent: reason and history are kept. */
    setAllocation(provider, allocationUsd, reason) {
      return withLock(async () => {
        const providerData = data.providers[provider];
        if (!providerData) throw new Error('Unknown paid provider');
        if (typeof reason !== 'string' || reason.trim().length < 3) throw new Error('A reason (for example the owner decision) is required');
        const nextMicros = toMicros(allocationUsd);
        if (!(nextMicros > 0)) throw new Error('allocationUsd must be positive');
        const committed = totals(provider).committedMicros;
        if (nextMicros < committed) throw new Error(`Cannot set ${provider} below the ${fromMicros(committed)} USD already settled, reserved or uncertain`);
        providerData.allocationHistory = [...(providerData.allocationHistory ?? []), { at: now(), fromMicros: providerData.allocationMicros, toMicros: nextMicros, reason: reason.trim().slice(0, 300) }];
        providerData.allocationMicros = nextMicros;
        await persist();
        return fromMicros(nextMicros);
      });
    },

    setPaused(provider, paused, reason) {
      return withLock(async () => {
        const providerData = data.providers[provider];
        if (!providerData) throw new Error('Unknown paid provider');
        if (typeof reason !== 'string' || reason.trim().length < 3) throw new Error('A reason is required');
        providerData.paused = Boolean(paused);
        providerData.pauseReason = paused ? reason.trim().slice(0, 300) : null;
        providerData.pauseHistory.push({ at: now(), paused: Boolean(paused), reason: reason.trim().slice(0, 300) });
        await persist();
        return true;
      });
    },

    /** Store a provider balance observation (numbers only, never credentials). */
    recordBalance(provider, observation) {
      return withLock(async () => {
        const providerData = data.providers[provider];
        if (!providerData) throw new Error('Unknown paid provider');
        const record = { at: now(), ...observation };
        providerData.balances.push(record);
        await persist();
        return record;
      });
    },

    totals,
  };
}
