// In-memory access log and per-minute traffic buckets for the control panel. Lost on restart by design;
// stdout carries the same entries as JSON lines for a real log pipeline.

export class Telemetry {
  constructor({ logSize = 500, minutes = 60, stdout = true } = {}) {
    this.logSize = logSize; this.minutes = minutes; this.stdout = stdout;
    this.entries = []; this.buckets = []; this.startedAt = Date.now();
  }

  record(entry) {
    this.entries.push(entry);
    if (this.entries.length > this.logSize) this.entries.splice(0, this.entries.length - this.logSize);
    const minute = Math.floor(entry.at / 60000) * 60000;
    let bucket = this.buckets.at(-1);
    if (!bucket || bucket.minute !== minute) {
      bucket = { minute, requests: 0, errors: 0, totalMs: 0, maxMs: 0, origins: {} };
      this.buckets.push(bucket);
      while (this.buckets.length && this.buckets[0].minute <= minute - this.minutes * 60000) this.buckets.shift();
    }
    bucket.requests++;
    if (entry.status >= 500) bucket.errors++;
    bucket.totalMs += entry.ms; bucket.maxMs = Math.max(bucket.maxMs, entry.ms);
    if (entry.origin) bucket.origins[entry.origin] = (bucket.origins[entry.origin] || 0) + 1;
    if (this.stdout) console.log(JSON.stringify({ type: 'access', ...entry, at: new Date(entry.at).toISOString() }));
  }

  recent(limit = 100) { return this.entries.slice(-limit).reverse(); }

  series() {
    const now = Math.floor(Date.now() / 60000) * 60000;
    const byMinute = new Map(this.buckets.map(bucket => [bucket.minute, bucket]));
    const points = [];
    for (let minute = now - (this.minutes - 1) * 60000; minute <= now; minute += 60000) {
      const bucket = byMinute.get(minute);
      points.push({ minute, requests: bucket?.requests || 0, errors: bucket?.errors || 0, avgMs: bucket?.requests ? Math.round(bucket.totalMs / bucket.requests) : null, maxMs: bucket?.maxMs || null, origins: bucket?.origins || {} });
    }
    return points;
  }

  totals() {
    const recent = this.buckets.filter(bucket => bucket.minute > Date.now() - 5 * 60000);
    const requests = recent.reduce((sum, bucket) => sum + bucket.requests, 0);
    const errors = recent.reduce((sum, bucket) => sum + bucket.errors, 0);
    const totalMs = recent.reduce((sum, bucket) => sum + bucket.totalMs, 0);
    return { windowMinutes: 5, requests, errors, errorRate: requests ? errors / requests : 0, avgMs: requests ? Math.round(totalMs / requests) : null };
  }
}
