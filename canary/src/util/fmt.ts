/** Small formatters, kept honest: no rounding that flatters anybody. */

export function pct(n: number, digits = 1): string {
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(digits)}%`;
}

export function eth(wei: bigint, digits = 4): string {
  const whole = wei / 10n ** 18n;
  const frac = wei % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, "0").slice(0, digits);
  return `${whole}.${fracStr}`;
}

export function units(raw: bigint, decimals: number, digits = 4): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return raw.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  if (digits <= 0 || decimals === 0) return whole.toString();
  const frac = raw % scale;
  const shown = Math.min(digits, decimals);
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, shown);
  return `${whole}.${fracStr}`;
}

export function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

export function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function bar(fill: number, width = 20): string {
  const n = Math.max(0, Math.min(width, Math.round((fill / 100) * width)));
  return "█".repeat(n) + "░".repeat(width - n);
}
