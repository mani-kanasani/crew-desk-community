// Usage accounting for Claude CLI stream-json runs.
//
// Claude CLI reports Anthropic Messages API usage. In that format the four
// token categories are disjoint: input_tokens excludes cache reads and cache
// writes, so each category is summed exactly once. A missing counter is
// unknown (null), never zero. The CLI's final result event carries per-model
// session totals (modelUsage); those replace, rather than add to, the
// per-message observations collected while the run was in flight.

export const USAGE_CATEGORIES = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'];

function count(value) {
  const n = Number(value);
  return value != null && Number.isFinite(n) && n >= 0 ? n : null;
}

function emptyTotals() {
  return { inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null };
}

/** Anthropic per-message usage → category counters (null when not reported). */
export function normalizeMessageUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    inputTokens: count(usage.input_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheWriteTokens: count(usage.cache_creation_input_tokens),
    outputTokens: count(usage.output_tokens),
  };
}

/** Claude CLI result.modelUsage entry → category counters. */
export function normalizeModelUsage(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    inputTokens: count(entry.inputTokens ?? entry.input_tokens),
    cacheReadTokens: count(entry.cacheReadInputTokens ?? entry.cache_read_input_tokens),
    cacheWriteTokens: count(entry.cacheCreationInputTokens ?? entry.cache_creation_input_tokens),
    outputTokens: count(entry.outputTokens ?? entry.output_tokens),
    ...(count(entry.costUSD) != null ? { cliCostUsd: count(entry.costUSD) } : {}),
  };
}

/** Sum counters; a category stays null only if every contributor lacks it. */
function addTotals(target, source, missing) {
  for (const key of USAGE_CATEGORIES) {
    const value = source?.[key];
    if (value == null) { missing.add(key); continue; }
    target[key] = (target[key] ?? 0) + value;
  }
}

export function createUsageTracker() {
  const messages = new Map();
  let anonymousCount = 0;
  let sessionModel = null;
  let result = null;
  let streamingId = null;

  // Keep the largest value seen per category for one API message; repeated
  // reports of the same message are never added together.
  function merge(id, model, usage) {
    const previous = messages.get(id);
    const merged = { ...(previous?.usage ?? emptyTotals()) };
    for (const key of USAGE_CATEGORIES) {
      if (usage?.[key] != null) merged[key] = Math.max(merged[key] ?? 0, usage[key]);
    }
    messages.set(id, { model: model ?? previous?.model ?? null, usage: merged });
    return true;
  }

  function observeAssistant(event) {
    const message = event.message;
    if (!message || typeof message !== 'object') return false;
    const usage = normalizeMessageUsage(message.usage);
    if (!usage) return false;
    // Assistant events carry message_start usage: input/cache counts are
    // final, but output_tokens is only a placeholder until message_delta.
    let id = typeof message.id === 'string' && message.id ? message.id : null;
    if (id && streamingId?.startsWith('anonymous-') && !messages.has(id) && messages.has(streamingId)) {
      // The stream's message_start had no id but this block names it: re-key
      // so one API message is never stored (and summed) under two keys.
      messages.set(id, messages.get(streamingId));
      messages.delete(streamingId);
      streamingId = id;
    }
    if (!id) id = streamingId ?? `anonymous-${anonymousCount += 1}`;
    return merge(id, typeof message.model === 'string' ? message.model : null, usage);
  }

  // --include-partial-messages: raw Messages API stream events. message_delta
  // usage is cumulative for the message currently streaming.
  function observeStream(raw) {
    if (!raw || typeof raw !== 'object') return false;
    if (raw.type === 'message_start' && raw.message) {
      streamingId = typeof raw.message.id === 'string' && raw.message.id ? raw.message.id : `anonymous-${anonymousCount += 1}`;
      return merge(streamingId, typeof raw.message.model === 'string' ? raw.message.model : null, normalizeMessageUsage(raw.message.usage));
    }
    if (raw.type === 'message_delta' && raw.usage && streamingId) return merge(streamingId, null, normalizeMessageUsage(raw.usage));
    return false;
  }

  return {
    /** Returns true when the observation changed in-flight usage. */
    observe(event) {
      if (!event || typeof event !== 'object') return false;
      if (event.type === 'system' && event.subtype === 'init' && typeof event.model === 'string') { sessionModel = event.model; return false; }
      if (event.type === 'stream_event') return observeStream(event.event);
      if (event.type === 'assistant') return observeAssistant(event);
      if (event.type === 'result') {
        const modelUsage = {};
        if (event.modelUsage && typeof event.modelUsage === 'object') {
          for (const [model, entry] of Object.entries(event.modelUsage)) {
            const normalized = normalizeModelUsage(entry);
            if (normalized) modelUsage[model] = normalized;
          }
        }
        result = {
          subtype: typeof event.subtype === 'string' ? event.subtype : null,
          isError: Boolean(event.is_error),
          numTurns: count(event.num_turns),
          cliTotalCostUsd: count(event.total_cost_usd ?? event.cost_usd),
          aggregate: normalizeMessageUsage(event.usage),
          modelUsage,
        };
        return true;
      }
      return false;
    },

    snapshot() {
      const inFlight = emptyTotals();
      const inFlightMissing = new Set();
      const observedModels = new Set();
      for (const { model, usage } of messages.values()) {
        addTotals(inFlight, usage, inFlightMissing);
        if (model) observedModels.add(model);
      }
      const base = {
        sessionModel,
        observedModels: [...observedModels],
        apiMessages: messages.size,
        inFlight,
        maxCallContextTokens: Math.max(0, ...[...messages.values()].map(({ usage }) => (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))),
        result: result ? { subtype: result.subtype, isError: result.isError, numTurns: result.numTurns, cliTotalCostUsd: result.cliTotalCostUsd } : null,
      };
      if (result && Object.keys(result.modelUsage).length) {
        const totals = emptyTotals();
        const missing = new Set();
        for (const entry of Object.values(result.modelUsage)) addTotals(totals, entry, missing);
        return { ...base, source: 'cli-result-modelUsage', completeness: missing.size ? 'reported-partial' : 'reported', missingCategories: [...missing], totals, perModel: result.modelUsage };
      }
      if (result?.aggregate) {
        const missing = USAGE_CATEGORIES.filter((key) => result.aggregate[key] == null);
        return { ...base, source: 'cli-result-usage', completeness: missing.length ? 'reported-partial' : 'reported', missingCategories: missing, totals: result.aggregate, perModel: null };
      }
      if (messages.size) {
        return { ...base, source: 'in-flight-messages', completeness: 'partial', missingCategories: [...inFlightMissing], totals: inFlight, perModel: null };
      }
      return { ...base, source: 'none', completeness: 'unknown', missingCategories: [...USAGE_CATEGORIES], totals: emptyTotals(), perModel: null };
    },
  };
}

/**
 * Estimate USD cost from category totals and a per-million-token price card.
 * Unknown categories are reported, and the estimate is marked incomplete.
 * Cache writes use their published price, or the uncached input price when a
 * provider does not publish one (the conservative choice).
 */
export function estimateCostUsd(totals, price) {
  if (!price) return { usd: null, complete: false, missing: [...USAGE_CATEGORIES], reason: 'no price card' };
  const rates = {
    inputTokens: price.inputPerMTok,
    cacheReadTokens: price.cacheReadPerMTok ?? price.inputPerMTok,
    cacheWriteTokens: price.cacheWritePerMTok ?? price.inputPerMTok,
    outputTokens: price.outputPerMTok,
  };
  let micro = 0;
  const missing = [];
  for (const key of USAGE_CATEGORIES) {
    const tokens = totals?.[key];
    if (tokens == null) { missing.push(key); continue; }
    micro += tokens * rates[key];
  }
  // Nothing reported is unknown, never $0.
  if (missing.length === USAGE_CATEGORIES.length) return { usd: null, complete: false, missing };
  // Rates are USD per 1M tokens, so micro is USD × 1e6. Round up to 1e-6 USD.
  const usd = Math.ceil(micro) / 1e6;
  return { usd, complete: missing.length === 0, missing };
}

/**
 * Worst-case USD for one API call: every context token at the highest input
 * rate (uncached or cache write) plus the enforced output cap.
 */
export function worstCaseCallUsd(price, maxOutputTokens, contextTokens = price.contextWindowTokens) {
  const input = Math.min(contextTokens, price.contextWindowTokens) * Math.max(price.inputPerMTok, price.cacheWritePerMTok ?? 0);
  const output = maxOutputTokens * price.outputPerMTok;
  return Math.ceil(input + output) / 1e6;
}

/** Normalize a model id for requested-versus-reported comparison. */
export function modelKey(model) {
  return String(model ?? '').trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
}
