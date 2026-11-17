// GTA VI launch-day Twitch viewers, hour by hour (make.fun gta6-twitch-ccu-forecast-01).
//
// The forecast for hours 2..24 of the release day (UTC) is built from the 38-42 past
// big launches shipped in the case ("comparables"), in three steps:
//
//   1. Shape. For every past launch, take the log of its viewers in each release-day
//      hour over its hour-1 print, ln(v_h / v_1). Launches whose hour 1 is *before*
//      anyone can play -- a single global unlock later in the day, visible as one
//      hour jumping >= 4x from a pre-release level -- are set aside: their hour-1
//      print is not a launch print, so their p1-anchored curve means something else.
//      The remaining ("rolling-midnight") launches are the shape pool.
//
//   2. Scale. A launch's curve depends strongly on how big its hour-1 print already
//      is: across the pool, corr(ln p1, ln(v_h / v_1)) runs from ~0 at hour 2 to
//      about -0.89 by hour 20 -- the bigger the first hour, the flatter the rest of
//      the day (the largest launches peak in hour 1 and decay; small ones keep
//      climbing as regions unlock). So each hour's curve value is a Gaussian-kernel
//      weighted mean over the pool in ln p1 (bandwidth 1.0), trimmed 15% of weight
//      from each tail, then smoothed over neighbouring hours. The kernel saturates:
//      a first hour larger than any past launch is forecast like the largest past
//      launches, not extrapolated linearly past them.
//
//   3. Spread. For every pool launch, the curve is refit without it (leave-one-out,
//      at that launch's own p1) and the residual in each hour is recorded. The
//      spread sigma_h is the standard deviation of the residuals of the 12 pool
//      launches nearest the target in ln p1 -- big launches get the tighter spread
//      big launches earned, small ones the wider spread they earned -- floored at
//      0.15, capped at 1.2, smoothed over neighbouring hours. Quantiles are
//      q_tau(h) = p1 * exp(m_h + z_tau * sigma_h).
//
// Everything is fit at run time from the case file alone: no network, no stored
// tables, deterministic. If anything about a case is unusable (no hour-1 print, no
// shape pool), the program falls back to the house persistence baseline rather
// than failing, because an invalid case scores as the hour-1 print everywhere and
// takes the entry out of the prizes.
//
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level (the house baseline's values). */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Persistence fallback: spread in log units per square-root hour. */
const FALLBACK_SIGMA = 0.15;

/** Gaussian kernel bandwidth on ln(hour-1 print) for the shape weights. */
const KERNEL_BW = 1.0;
/** Weight trimmed from each tail before the kernel-weighted mean of log-ratios. */
const TRIM_FRAC = 0.15;
/** Pool launches nearest the target in ln p1 whose LOO residuals set sigma. */
const SIGMA_NEIGHBOURS = 12;
/** Floor / cap on sigma, in log units. */
const SIGMA_FLOOR = 0.15;
const SIGMA_CAP = 1.2;
/** A shape pool smaller than this falls back to every usable comparable. */
const MIN_POOL = 5;

interface RawPoint { from: string; viewers: number | null; channels?: number | null }
interface RawComparable {
  name: string;
  day_start: string;
  unlock?: string;
  platforms?: string;
  hourly: RawPoint[];
}
interface CaseInput {
  game?: { name?: string };
  day_start?: string;
  levels?: number[];
  known?: Array<{ hour: number; viewers: number }>;
  forecast?: Array<{ hour: number }>;
  history?: Array<{ at?: string; from?: string; viewers: number | null }>;
  comparables?: RawComparable[];
}

/** One past launch, reduced to its release-day curve and its hour-1 print. */
interface Prepared {
  name: string;
  p1: number;
  day: Array<number | null>;
  pre: number;
  rolling: boolean;
  logRatio: Array<number | null>;
}

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a: number[]): number => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
};
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
/** x rounded to 2 decimals (half up), at least 1 viewer. */
const round2 = (x: number): number => Math.max(1, Math.round(x * 100) / 100);

/** The inverse standard normal CDF (Acklam's rational approximation), only used when
 *  a case asks for levels other than the five standard ones. */
const normInv = (p: number): number => {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285984469534e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
};

/** The z-values for a case's levels: the standard five, else the inverse normal. */
const zFor = (levels: number[]): number[] =>
  levels.length === LEVELS.length && levels.every((t, j) => t === LEVELS[j])
    ? Z
    : levels.map((t) => normInv(clamp(t, 1e-6, 1 - 1e-6)));

/** The release day's 24 hourly viewer counts, index 0 = hour 1, null where missing. */
const releaseDay = (hourly: RawPoint[], dayStartMs: number): Array<number | null> => {
  const out: Array<number | null> = new Array(24).fill(null);
  for (const p of hourly) {
    if (p.viewers == null || p.viewers <= 0) continue;
    const h = Math.round((Date.parse(p.from) - dayStartMs) / 3600000);
    if (h >= 0 && h < 24) out[h] = p.viewers;
  }
  return out;
};

/** Median hourly viewers in the 7 days before the release day (the pre-launch level). */
const preBaseline = (hourly: RawPoint[], dayStartMs: number): number | null => {
  const pts: number[] = [];
  for (const p of hourly) {
    const t = Date.parse(p.from);
    if (t >= dayStartMs - 7 * 86400000 && t < dayStartMs && p.viewers != null && p.viewers > 0) pts.push(p.viewers);
  }
  return pts.length >= 3 ? median(pts) : null;
};

/** Hour (0-indexed) of a sharp single-hour jump into >= 5x the pre-launch level, in the
 *  first 16 hours: a single global unlock later in the day, not a rolling midnight.
 *  Null when there is none: hour 1 is a launch print. */
const jumpHour = (day: Array<number | null>, pre: number): number | null => {
  for (let h = 0; h < 16; h++) {
    const a = day[h];
    const b = day[h + 1];
    if (a != null && b != null && a > 0 && b / a >= 4 && b >= 5 * pre) return h + 1;
  }
  return null;
};

/** Reduce one comparable to its release-day curve, or null when it cannot anchor one:
 *  no hour-1 print, no pre-launch level, or it is the target game itself (its own
 *  pre-release history is not a launch). */
const prepare = (c: RawComparable, targetName: string): Prepared | null => {
  if (!c || typeof c.name !== 'string' || !Array.isArray(c.hourly)) return null;
  if (targetName && (c.name === targetName || c.name.startsWith(`${targetName} `) || c.name.startsWith(`${targetName} category`))) return null;
  const t0 = Date.parse(c.day_start);
  if (!Number.isFinite(t0)) return null;
  const day = releaseDay(c.hourly, t0);
  const pre = preBaseline(c.hourly, t0);
  if (day[0] == null || pre == null) return null;
  const p1 = day[0];
  return {
    name: c.name,
    p1,
    day,
    pre,
    rolling: jumpHour(day, pre) === null,
    logRatio: day.map((v) => (v == null ? null : Math.log(v / p1))),
  };
};

/** A 3-point moving average with clamped edges (used for the curve and for sigma). */
const smooth3 = (xs: number[]): number[] =>
  xs.map((_, i) => mean([xs[Math.max(0, i - 1)], xs[i], xs[Math.min(xs.length - 1, i + 1)]]));

/** The 23 log-ratio values ln(v_h / p1), h = 2..24, for a target whose hour-1 print is
 *  tp1: a Gaussian-kernel (in ln p1) weighted, tail-trimmed mean over the pool, then
 *  smoothed over neighbouring hours. */
const fitCurve = (pool: Prepared[], tp1: number): number[] => {
  const logTp1 = Math.log(tp1);
  const weights = pool.map((c) => Math.exp(-0.5 * ((Math.log(c.p1) - logTp1) / KERNEL_BW) ** 2));
  const curve: number[] = [];
  for (let h = 1; h < 24; h++) {
    let pairs = pool
      .map((c, i): [number, number] | null => (c.logRatio[h] == null ? null : [c.logRatio[h] as number, weights[i]]))
      .filter((p): p is [number, number] => p !== null);
    if (pairs.length === 0) {
      curve.push(0);
      continue;
    }
    if (TRIM_FRAC > 0 && pairs.length >= 5) {
      const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
      const tot = sorted.reduce((s, [, w]) => s + w, 0);
      const keep: Array<[number, number]> = [];
      let acc = 0;
      for (const [v, w] of sorted) {
        if (acc + w > TRIM_FRAC * tot && acc < (1 - TRIM_FRAC) * tot) keep.push([v, w]);
        acc += w;
      }
      if (keep.length >= 3) pairs = keep;
    }
    const tot = pairs.reduce((s, [, w]) => s + w, 0);
    curve.push(tot > 0 ? pairs.reduce((s, [v, w]) => s + v * w, 0) / tot : 0);
  }
  return smooth3(curve);
};

/** The per-hour spread sigma_h from leave-one-out residuals: refit the curve without
 *  each pool launch (at that launch's own p1), take its residual each hour, and use the
 *  standard deviation of the residuals of the SIGMA_NEIGHBOURS pool launches nearest
 *  the target in ln p1. Floored, capped, smoothed. */
const fitSigma = (pool: Prepared[], tp1: number): number[] => {
  const logTp1 = Math.log(tp1);
  const residByMember: Array<Array<number | null>> = [];
  for (let i = 0; i < pool.length; i++) {
    const rest = pool.filter((_, j) => j !== i);
    const looCurve = fitCurve(rest, pool[i].p1);
    residByMember.push(
      Array.from({ length: 23 }, (_, k) => {
        const v = pool[i].logRatio[k + 1];
        return v == null ? null : v - looCurve[k];
      }),
    );
  }
  const order = pool
    .map((c, i) => [Math.abs(Math.log(c.p1) - logTp1), i] as [number, number])
    .sort((a, b) => a[0] - b[0])
    .slice(0, SIGMA_NEIGHBOURS)
    .map(([, i]) => i);
  const sigma: number[] = [];
  for (let h = 0; h < 23; h++) {
    const vals = order.map((i) => residByMember[i][h]).filter((v): v is number => v !== null);
    sigma.push(vals.length < 3 ? SIGMA_FLOOR : clamp(sd(vals), SIGMA_FLOOR, SIGMA_CAP));
  }
  return smooth3(sigma);
};

/** The persistence fallback: every hour stays at the hour-1 print, spread widening
 *  like a random walk in log space (the house baseline's numbers). */
const persistence = (p1: number, hours: number[], z: number[]): Array<{ hour: number; q: number[] }> =>
  hours.map((h) => ({
    hour: h,
    q: z.map((zz) => round2(p1 * Math.exp(zz * FALLBACK_SIGMA * Math.sqrt(h - 1)))),
  }));

/** Forecast one case. Never throws: any failure degrades to persistence, because a
 *  missing or crashed case is scored as the hour-1 print everywhere. */
const forecastCase = (c: CaseInput): { hours: Array<{ hour: number; q: number[] }> } => {
  const z = zFor(Array.isArray(c.levels) && c.levels.length ? c.levels : LEVELS);
  const hours = Array.isArray(c.forecast) && c.forecast.length
    ? c.forecast.map((f) => f.hour).filter((h) => Number.isFinite(h))
    : Array.from({ length: 23 }, (_, i) => i + 2);
  const first = Array.isArray(c.known) ? c.known.find((k) => k.hour === 1) : undefined;
  const p1 = Math.max(1, first && Number.isFinite(first.viewers) ? first.viewers : 1);
  try {
    const targetName = c.game && typeof c.game.name === 'string' ? c.game.name : '';
    const prepared: Prepared[] = [];
    for (const raw of c.comparables ?? []) {
      const p = prepare(raw, targetName);
      if (p) prepared.push(p);
    }
    const rolling = prepared.filter((p) => p.rolling);
    const pool = rolling.length >= MIN_POOL ? rolling : prepared;
    if (pool.length === 0) return { hours: persistence(p1, hours, z) };
    const curve = fitCurve(pool, p1);
    const sigma = fitSigma(pool, p1);
    const out = hours.map((h) => {
      const m = curve[h - 2] ?? 0;
      const s = sigma[h - 2] ?? SIGMA_FLOOR;
      const q = z.map((zz) => round2(p1 * Math.exp(m + zz * s)));
      for (let j = 1; j < q.length; j++) if (q[j] < q[j - 1]) q[j] = q[j - 1];
      return { hour: h, q };
    });
    return { hours: out };
  } catch {
    return { hours: persistence(p1, hours, z) };
  }
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  let parsed: CaseInput;
  try {
    parsed = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseInput;
  } catch {
    // An unreadable case still gets a valid-shaped fallback keyed on hour 1 = 1.
    parsed = { levels: LEVELS, known: [{ hour: 1, viewers: 1 }], forecast: Array.from({ length: 23 }, (_, i) => ({ hour: i + 2 })) };
  }
  const out = forecastCase(parsed);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours: out.hours })}\n`);
}
