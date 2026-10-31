// All timestamps persisted by CloudDrive are UTC. Display uses the browser's IANA timezone.
const UTC_SQL = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/;
const UTC_MINUTE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
export function parseUtc(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  // Date-only values are calendar dates, not timestamps; never shift their day.
  if (DATE_ONLY.test(raw)) return null;
  const full = raw.match(UTC_SQL);
  const minute = raw.match(UTC_MINUTE);
  const iso = full ? `${full[1]}T${full[2]}${full[3] || ''}Z`
    : minute ? `${minute[1]}T${minute[2]}:00Z` : raw;
  // Only accept strings with explicit UTC/offset; local-looking strings are rejected.
  if (!full && !minute && !/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso)) return null;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date : null;
}
export function formatUtc(value, { fallback = '—', locale = 'zh-CN', seconds = false } = {}) {
  if (value == null || value === '') return fallback;
  const date = parseUtc(value);
  if (!date) return String(value);
  return new Intl.DateTimeFormat(locale, {
    timeZone: browserTimeZone(), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', ...(seconds ? {second: '2-digit'} : {}), hourCycle: 'h23'
  }).format(date);
}
export function localInputFromUtc(value) {
  const date = parseUtc(value);
  if (!date) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone: browserTimeZone(), year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit', hourCycle:'h23'}).formatToParts(date);
  const v = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${v.year}-${v.month}-${v.day}T${v.hour}:${v.minute}`;
}
export function utcFromLocalInput(input) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input || '')) return null;
  const d = new Date(input); // datetime-local is explicitly a browser-local time.
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
