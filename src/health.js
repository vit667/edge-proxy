export function failureReason(error) {
  const code = error?.cause?.code || error?.code || '';
  if (error?.name === 'TimeoutError' || code.includes('TIMEOUT')) return 'TIMEOUT';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'DNS';
  if (/CERT|TLS|SSL|SELF_SIGNED/.test(code)) return 'TLS';
  return 'CONNECTION';
}

/**
 * Active check of one origin. An agent's /_edge/health answers with JSON: its database generation (timeline of a
 * primary) is passed on so the balancer never routes to a server left behind by a failover.
 */
export async function checkOrigin(origin, timeoutMs, fetcher = fetch) {
  const started = Date.now();
  const path = origin.healthPath || '/healthz';
  try {
    const result = await fetcher(new URL(path, origin.url), { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    let generation = null, reason = null;
    if ((result.headers.get('content-type') || '').includes('application/json')) {
      try {
        const body = JSON.parse((await result.text()).slice(0, 4096));
        if (body?.db?.role === 'primary' && Number.isInteger(body.db.timeline)) generation = body.db.timeline;
        if (typeof body?.reason === 'string') reason = body.reason.slice(0, 60);
      } catch {}
    } else await result.body?.cancel();
    return { id: origin.id, path, healthy: result.status >= 200 && result.status < 400, status: result.status, latencyMs: Date.now() - started, generation, reason };
  } catch (error) {
    return { id: origin.id, path, healthy: false, error: failureReason(error), latencyMs: Date.now() - started, generation: null, reason: null };
  }
}
