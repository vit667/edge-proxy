export type Origin = {
  id: string; url: string; priority: number; weight?: number; healthPath?: string; readOnly?: boolean; rewriteHost?: boolean;
};
export type WebhookRoute = { id: string; path: string; provider: 'telegram'; secretEnv: string; botTokenEnv?: string; checkSourceIp?: boolean };
export type WebhookState = {
  id: string; secretConfigured: boolean; botTokenConfigured: boolean; accepted: number; rejected: number;
  lastAt: number | null; lastStatus: number | null; lastReject: { at: number; reason: string } | null;
};
export type TelegramInfo = {
  url: string; pathMatches: boolean | null; pendingUpdates: number; ipAddress: string | null; lastErrorAt: number | null;
  lastError: string | null; lastSyncErrorAt: number | null; maxConnections: number | null; allowedUpdates: string[] | null;
};
export type DatabaseNode = { id: string; host: string; port: number; replicationHost?: string; replicationPort?: number };
export type Config = {
  app: string; revision: number; timeoutMs: number; maxBodyBytes: number; maxUploadBytes?: number; healthIntervalMs?: number;
  retryWrites?: boolean; exposeDebugHeaders?: boolean; circuit?: { failureThreshold?: number; cooldownMs?: number };
  origins: Origin[]; database?: { name?: string; nodes: DatabaseNode[] }; webhooks?: WebhookRoute[];
};
export type Circuit = 'closed' | 'half-open' | 'open';
export type OriginState = {
  id: string; circuit: Circuit; failures: number; requests: number; errors: number; latencyMs: number | null;
  lastStatus: number | null; lastError: string | null; lastChangeAt: number; retryAt: number | null;
  check: { healthy: boolean; status?: number; error?: string; latencyMs: number; path: string; at: number; generation?: number | null; reason?: string | null } | null;
  /** Left behind by a database failover: never routed to */
  stale?: boolean;
  /** Its own agent says it must not serve (for example, its database is a replica) */
  declined?: boolean;
};
export type NodeHealth = {
  ready: boolean; reason: string | null; fenced: boolean; fenceGeneration: number | null;
  app: { ok: boolean; status: number | null; version: string | null; unchecked?: boolean };
  db: { reachable: boolean; role: 'primary' | 'standby' | null; timeline: number | null; readOnly?: boolean; error?: string } | null;
  peers: { url: string; role: string | null; timeline: number | null }[];
};
export type Status = {
  node: string; startedAt: number; version: string; edgeAuthDisabled: boolean; config: Config; origins: OriginState[];
  traffic: { windowMinutes: number; requests: number; errors: number; errorRate: number; avgMs: number | null };
  webhooks: WebhookState[];
  nodeHealth: NodeHealth | null;
};
export type LogEntry = { at: number; method: string; path: string; status: number; origin: string | null; attempts: number; ms: number; ip: string; error: string | null; webhook: string | null };
export type Traffic = { series: { minute: number; requests: number; errors: number; avgMs: number | null; maxMs: number | null; origins: Record<string, number> }[]; log: LogEntry[] };
export type HistoryEntry = { revision: number; appliedAt: number; config: Config };

export type Sender = { name: string; clientAddr: string | null; state: string; syncState: string; replayLsn: string | null; replayLagSeconds: number | null; lagBytes: number | null };
export type Slot = { name: string; active: boolean; walStatus: string | null; safeWalBytes: number | null; retainedBytes: number | null };
export type DbNode = {
  id: string; reachable: boolean; error?: string; role?: 'primary' | 'standby'; version?: string; timeline?: number;
  readOnly?: boolean; currentLsn?: string | null; receivedLsn?: string | null; replayedLsn?: string | null; lastReplayAt?: string | null;
  synchronousStandbyNames?: string; synchronousCommit?: string; primarySlotName?: string;
  receiver?: { status: string; senderHost: string; senderPort: number; slotName: string | null } | null;
  upstream?: { host: string | null; port: number | null; slot: string | null } | null; upstreamId?: string | null;
  senders?: Sender[]; slots?: Slot[];
};
export type DbStatus = { nodes: DbNode[]; primary: string | null; warnings: { level: 'critical' | 'warning'; code: string; message: string }[]; controlEnabled: boolean };

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const storageKey = 'edge-admin-token';
// sessionStorage: the token survives a reload of this tab and disappears when the tab closes; other tabs never see it.
let token = (() => { try { return sessionStorage.getItem(storageKey) || ''; } catch { return ''; } })();
export const hasToken = () => !!token;
export function setToken(value: string) {
  token = value;
  try { if (value) sessionStorage.setItem(storageKey, value); else sessionStorage.removeItem(storageKey); } catch {}
}

const messages: Record<string, string> = {
  unauthorized: 'Неверный ADMIN_TOKEN.',
  revision_must_increase: 'На сервере уже есть эта или более новая revision.',
  invalid_configuration: 'Конфигурация не прошла проверку',
  update_in_progress: 'Другое обновление уже выполняется.',
  database_not_configured: 'В конфигурации нет раздела database.',
  control_disabled: 'Управление отключено: задайте агенту PG_ADMIN_USER и PG_ADMIN_PASSWORD.',
  primary_alive: 'Текущий primary ещё принимает запись.',
  standby_not_streaming: 'Выбранные standby сейчас не подключены — коммиты зависнут.',
  no_single_primary: 'Нужен ровно один доступный primary.',
  not_standby: 'Узел уже является primary.',
  slot_active: 'Слот используется подключённым standby.'
};

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method || 'GET', cache: 'no-store', signal: AbortSignal.timeout(90000),
    headers: { 'x-admin-token': token, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = data.error || 'http_error';
    const base = messages[code];
    throw new ApiError(response.status, code, base ? (data.message && !['unauthorized'].includes(code) ? `${base} ${data.message}` : base) : data.message || `Ошибка ${response.status}`);
  }
  return data as T;
}
