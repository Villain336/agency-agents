// Relative-time and small formatting helpers (pure).
const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function relTime(ts, now = Date.now()) {
  if (typeof ts !== "number" || !isFinite(ts)) return "";
  const d = now - ts;
  const a = Math.abs(d);
  const fut = d < 0;
  const wrap = (s) => (fut ? `in ${s}` : `${s} ago`);
  if (a < 45e3) return "just now";
  if (a < HOUR) return wrap(`${Math.max(1, Math.round(a / MIN))}m`);
  if (a < DAY) return wrap(`${Math.round(a / HOUR)}h`);
  if (a < 14 * DAY) return wrap(`${Math.round(a / DAY)}d`);
  if (a < 60 * DAY) return wrap(`${Math.round(a / (7 * DAY))}w`);
  const dt = new Date(ts);
  const y = dt.getUTCFullYear();
  return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}${y === new Date(now).getUTCFullYear() ? "" : ", " + y}`;
}

export function fullTime(ts) {
  if (typeof ts !== "number" || !isFinite(ts)) return "";
  return new Date(ts).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

export function fmtBytes(n) {
  if (typeof n !== "number") return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export const fmtDuration = (ms) => (ms < 1000 ? `${ms} ms` : ms < 60e3 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60e3)}m ${Math.round((ms % 60e3) / 1000)}s`);
export const plural = (n, w, pl = w + "s") => `${n} ${n === 1 ? w : pl}`;
