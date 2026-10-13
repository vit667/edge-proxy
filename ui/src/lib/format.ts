export const ms = (value: number | null | undefined) => (value === null || value === undefined ? '—' : value < 1000 ? `${value} мс` : `${(value / 1000).toFixed(1)} с`);

export function bytes(value: number | null | undefined) {
  if (value === null || value === undefined) return '—';
  if (value < 1024) return `${value} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let size = value / 1024, unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

export const number = (value: number) => new Intl.NumberFormat('ru-RU').format(value);
export const percent = (value: number) => `${(value * 100).toFixed(value > 0 && value < 0.01 ? 2 : 1)} %`;
export const time = (value: number | string) => new Date(value).toLocaleTimeString('ru-RU');
export const dateTime = (value: number | string) => new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function ago(value: number | string | null | undefined, now = Date.now()) {
  if (!value) return '—';
  const seconds = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000));
  if (seconds < 5) return 'только что';
  if (seconds < 60) return `${seconds} с назад`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин назад`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} ч назад`;
  return `${Math.floor(seconds / 86400)} д назад`;
}

export function duration(fromMs: number, now = Date.now()) {
  const seconds = Math.floor((now - fromMs) / 1000);
  if (seconds < 60) return `${seconds} с`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} ч ${Math.floor((seconds % 3600) / 60)} мин`;
  return `${Math.floor(seconds / 86400)} д ${Math.floor((seconds % 86400) / 3600)} ч`;
}

export const reasons: Record<string, string> = { DNS: 'Ошибка DNS', TLS: 'Ошибка TLS', TIMEOUT: 'Таймаут', CONNECTION: 'Нет соединения', CLIENT_CLOSED: 'Клиент отключился', BODY_TOO_LARGE: 'Тело слишком большое', AUTH: 'Ошибка входа', BAD_SECRET: 'Неверный secret token', SOURCE_IP: 'Чужой IP', METHOD: 'Не POST', SECRET_NOT_SET: 'Секрет не задан' };
export const reason = (value: string | null | undefined) => (value ? reasons[value] || value : '');
