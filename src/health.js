export function failureReason(error) {
  const code = error?.cause?.code || error?.code || '';
  if (error?.name === 'TimeoutError' || code.includes('TIMEOUT')) return 'TIMEOUT';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'DNS';
  if (/CERT|TLS|SSL|SELF_SIGNED/.test(code)) return 'TLS';
  return 'CONNECTION';
}

export async function checkOrigin(origin, timeoutMs, fetcher = fetch) {
  const started = Date.now();
  const path = origin.healthPath || '/healthz';
  try {
    const result = await fetcher(new URL(path, origin.url), { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await result.body?.cancel();
    return { id: origin.id, path, healthy: result.status >= 200 && result.status < 400, status: result.status, latencyMs: Date.now() - started };
  } catch (error) {
    return { id: origin.id, path, healthy: false, error: failureReason(error), latencyMs: Date.now() - started };
  }
}
