// Per-origin health state shared by all requests of one process (Node agent) or one isolate (Worker).
// Passive signals (real traffic) and active checks both feed a simple circuit breaker:
// closed → open after `failureThreshold` consecutive failures → half-open after `cooldownMs` (one probe) → closed on success.

export const circuitDefaults = { failureThreshold: 3, cooldownMs: 10000 };

const blank = () => ({
  failures: 0, openUntil: 0, probing: false, current: 0,
  requests: 0, errors: 0, latencyMs: null, lastStatus: null, lastError: null, lastChangeAt: Date.now(),
  check: null
});

export class OriginPool {
  constructor(now = () => Date.now()) { this.now = now; this.states = new Map(); }

  state(id) {
    if (!this.states.has(id)) this.states.set(id, blank());
    return this.states.get(id);
  }

  /** Drops state of origins that are no longer configured. */
  sync(config) {
    const ids = new Set(config.origins.map(origin => origin.id));
    for (const id of this.states.keys()) if (!ids.has(id)) this.states.delete(id);
  }

  circuit(id) {
    const state = this.state(id);
    if (state.openUntil === 0) return 'closed';
    return this.now() < state.openUntil || state.probing ? 'open' : 'half-open';
  }

  /**
   * Orders candidates for one request: available origins by priority, weighted round-robin inside a priority,
   * then open circuits as a last resort so a total outage still gets a chance to recover.
   */
  order(origins) {
    const available = [], open = [];
    for (const origin of origins) (this.circuit(origin.id) === 'open' ? open : available).push(origin);
    const groups = new Map();
    for (const origin of available) {
      if (!groups.has(origin.priority)) groups.set(origin.priority, []);
      groups.get(origin.priority).push(origin);
    }
    const ordered = [];
    for (const priority of [...groups.keys()].sort((a, b) => a - b)) ordered.push(...this.#weighted(groups.get(priority)));
    open.sort((a, b) => this.state(a.id).openUntil - this.state(b.id).openUntil);
    return [...ordered, ...open];
  }

  // Smooth weighted round-robin (as in nginx): deterministic and evenly interleaved.
  #weighted(group) {
    if (group.length < 2) return group;
    const total = group.reduce((sum, origin) => sum + (origin.weight ?? 1), 0);
    let best;
    for (const origin of group) {
      const state = this.state(origin.id);
      state.current += origin.weight ?? 1;
      if (!best || state.current > this.state(best.id).current) best = origin;
    }
    this.state(best.id).current -= total;
    return [best, ...group.filter(origin => origin !== best)];
  }

  /** Marks the start of an attempt; a half-open circuit admits only one probe at a time. */
  begin(id) {
    const state = this.state(id);
    if (this.circuit(id) === 'half-open') state.probing = true;
    state.requests++;
  }

  success(id, latencyMs, status) {
    const state = this.state(id);
    if (state.openUntil) state.lastChangeAt = this.now();
    state.failures = 0; state.openUntil = 0; state.probing = false;
    state.lastStatus = status; state.lastError = null;
    state.latencyMs = state.latencyMs === null ? latencyMs : Math.round(state.latencyMs * 0.8 + latencyMs * 0.2);
  }

  failure(id, reason, config, status = null) {
    const { failureThreshold, cooldownMs } = { ...circuitDefaults, ...config.circuit };
    const state = this.state(id);
    state.errors++; state.failures++; state.probing = false;
    state.lastStatus = status; state.lastError = reason;
    if (state.failures >= failureThreshold || state.openUntil) {
      if (!state.openUntil) state.lastChangeAt = this.now();
      state.openUntil = this.now() + cooldownMs;
    }
  }

  /** Active health check result. Failures open the circuit; a success closes it only after the cooldown. */
  checked(result, config) {
    const state = this.state(result.id);
    state.check = { ...result, at: this.now() };
    if (!result.healthy) this.failure(result.id, result.error || `HTTP ${result.status}`, { ...config, circuit: { ...circuitDefaults, ...config.circuit, failureThreshold: 1 } }, result.status ?? null);
    else if (this.circuit(result.id) !== 'open') this.success(result.id, result.latencyMs, result.status);
  }

  snapshot(config) {
    return config.origins.map(origin => {
      const state = this.state(origin.id);
      return {
        id: origin.id, circuit: this.circuit(origin.id), failures: state.failures,
        requests: state.requests, errors: state.errors, latencyMs: state.latencyMs,
        lastStatus: state.lastStatus, lastError: state.lastError, lastChangeAt: state.lastChangeAt,
        retryAt: state.openUntil || null, check: state.check
      };
    });
  }
}
