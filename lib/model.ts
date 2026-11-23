// Token launch radar: the value model, the launch-odds model and the board.
//
// Both models are fitted, at run time, from the sealed snapshot's own
// figures. Nothing about any individual protocol is written into this file:
// no name lists, no per-protocol constants. The only inputs are the
// snapshot's ten fields per protocol.
//
// Value model, in the order the code runs it:
//   1. Comparable set: protocols whose token already trades at a measurable
//      cap (mcap_usd > 0). Protocols that record a token but no measurable
//      cap are set aside as "listed, unpriced" and never used as evidence;
//      protocols with no token recorded are the board's subjects.
//   2. Three candidate variants are fitted and raced on held-out data:
//      A, the v1 form (a log-log TVL curve, per-category median-residual
//      offsets shrunk n/(n+4), and growth / track-record terms fitted on
//      the residuals and applied at a quarter of their fitted strength);
//      B, per-category slopes shrunk toward the global slope plus a ridge
//      regression over 25 interpretable features derived from the snapshot
//      fields (growth shape, age shape, chain footprint, size context,
//      name shape, and two interactions), its penalty chosen by inner
//      cross-validation; and C, the log-space average of A and B.
//   3. The race is run on three outer splits the fitting never sees: two
//      expanding-window walk-forwards over the comparables' listing dates
//      and one blind slug-ordered holdout, with a slug three-fold score
//      kept for reference. The variant with the lowest mean holdout median
//      factor error is refitted on every comparable and becomes the board.
//   4. Interval: the estimate's range is the fitted value shifted by the
//      category's residual quartiles (shrunk toward the global quartiles),
//      because the honest finding of every fit is that value given TVL is
//      a range, not a point: the typical miss is a factor of about four.
//
// Launch-odds model: a logistic regression over every protocol in the
// snapshot (the outcome is whether a token is recorded at all), on log
// TVL, log age, chain count, seven-day growth and the protocol's own
// category launch rate among its peers, shrunk toward the global rate.
// It is scored on a blind holdout (AUC and Brier score, printed on the
// dashboard), and each row also carries the raw peer record behind the
// odds: its category's launched share, its age band's and its TVL band's.
//
// Farm verdicts: each row's plan is judged from its own numbers — the
// fitted launch odds times the implied value (the probability-weighted
// value), against the plan's full cost in fees plus reader time valued
// at a stated rate. The rule and its thresholds are computed from the
// board itself and printed in the dashboard's method panel.
//
// Validation is deterministic throughout: every split is by slug order or
// by listing date, every fit is closed-form or iterated to a fixed
// tolerance, and no clock or randomness is consulted anywhere.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Board size target: every watchlist protocol, plus the best of the rest. */
export const BOARD_TARGET = 280;

/** Strength at which the growth / track-record adjustments are applied. */
export const ADJUSTMENT_SHRINK = 0.25;

/** Shrinkage constant for category offsets: n / (n + CATEGORY_SHRINK). */
export const CATEGORY_SHRINK = 4;

/** Days between the snapshot's as_of and a protocol's listed_at, or null. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((a - b) / 86_400_000));
}

/** A protocol records no token when both token fields are null. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule, the same pattern the watchlist uses. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whole words that mark a wrapped or staked product of another asset. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Exchange names a product may not begin with, as the watchlist rule lists them. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/**
 * Whether a protocol is a launch candidate the board may rank. The tests
 * mirror the watchlist's own product tests, applied at every size instead
 * of only above the floor: no token recorded; not an exchange (an
 * exchange's reserves are a balance sheet, not a protocol awaiting its own
 * launch); not a canonical bridge (a chain's own asset pipe); not a
 * versioned pool of another protocol; not a wrapped or staked product by
 * name; and not a one-chain "bridge" — a bridge holds assets on at least
 * two chains, so a Bridge-category entry on a single chain is a wrapped
 * representation of an asset that already trades, not a bridge protocol.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!recordsNoToken(p)) return false;
  if (p.category === 'CEX' || p.category === 'Canonical Bridge') return false;
  if (VERSIONED.test(p.name) || WRAPPED_WORD.test(p.name) || EXCHANGE_PREFIX.test(p.name)) return false;
  if (p.category === 'Bridge' && p.chains.length < 2) return false;
  return true;
}

/** The seven-day change, clamped to the range the fit was made on. */
function growthClamped(p: SnapshotProtocol): number {
  if (p.change_7d === null || !Number.isFinite(p.change_7d)) return 0;
  return Math.max(-50, Math.min(50, p.change_7d));
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function quartile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

export interface CategoryFit {
  category: string;
  samples: number;
  offset: number; // log-space shift applied to this category
  rawMedianResidual: number;
  impliedMultiple: number; // exp(offset) relative to the TVL curve
  slope: number | null; // this category's own fitted slope, when it has one
}

export interface CvRow {
  variant: string;
  medianFactor: number;
  within2xPct: number;
  within4xPct: number;
}

/** One model variant's median factor error on one held-out split. */
export interface ValidationRow {
  variant: string;
  walkForward1: number;
  walkForward2: number;
  blind: number;
  threeFold: number;
  mean: number; // mean of the three outer splits: the number the race is judged on
  chosen: boolean;
}

/** The launch-odds model's report, carried into the dashboard. */
export interface LaunchFitInfo {
  samples: number;
  launched: number;
  baseRate: number;
  auc: number; // blind-holdout AUC
  brier: number; // blind-holdout Brier score
  features: string[];
}

export interface ModelFit {
  samples: number;
  unpricedListed: number;
  variant: string; // the variant that won the validation race
  featureCount: number; // fitted terms in the winning value model
  featureNames: string[]; // the ridge feature names (variant B's dictionary)
  lambda: number | null; // variant B's chosen ridge penalty, when fitted
  slope: number;
  intercept: number;
  growthCoef: number; // variant A reporting: per +1% of seven-day change, after shrink
  ageCoef: number; // variant A reporting: per year with no token, after shrink
  categories: CategoryFit[];
  residQ25: number;
  residQ75: number;
  validation: ValidationRow[];
  cv: CvRow[];
  holdoutMedianFactor: number;
  launch: LaunchFitInfo;
}

interface RawFit {
  slope: number;
  intercept: number;
  offsets: Map<string, { n: number; offset: number; raw: number }>;
  growthCoef: number;
  ageCoef: number;
  predict: (p: SnapshotProtocol) => number; // log space
  residuals: Map<string, number[]>; // by category, log space
  globalResid: number[];
}

function olsLine(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  const slope = sxx === 0 ? 1 : sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

function univariateSlope(rows: { x: number; y: number }[]): number {
  const n = rows.length;
  const mx = rows.reduce((a, r) => a + r.x, 0) / n;
  const my = rows.reduce((a, r) => a + r.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const r of rows) {
    num += (r.x - mx) * (r.y - my);
    den += (r.x - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** Fit the level line, category offsets and (shrunk) adjustment terms. */
function fitRaw(train: SnapshotProtocol[], asOf: string, shrink: number): RawFit {
  const { slope, intercept } = olsLine(
    train.map((p) => Math.log(p.tvl_usd)),
    train.map((p) => Math.log(p.mcap_usd!)),
  );
  const base = (p: SnapshotProtocol) => intercept + slope * Math.log(p.tvl_usd);
  const byCat = new Map<string, number[]>();
  for (const p of train) {
    const key = p.category ?? '(uncategorised)';
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key)!.push(Math.log(p.mcap_usd!) - base(p));
  }
  const offsets = new Map<string, { n: number; offset: number; raw: number }>();
  for (const [key, resid] of byCat) {
    const raw = median(resid);
    offsets.set(key, { n: resid.length, offset: (resid.length / (resid.length + CATEGORY_SHRINK)) * raw, raw });
  }
  const offsetOf = (p: SnapshotProtocol) => offsets.get(p.category ?? '(uncategorised)')?.offset ?? 0;
  const residAfterCat = train.map((p) => Math.log(p.mcap_usd!) - base(p) - offsetOf(p));
  const growthCoef =
    univariateSlope(train.map((p, i) => ({ x: growthClamped(p), y: residAfterCat[i]! }))) * shrink;
  const residAfterGrowth = residAfterCat.map((r, i) => r - growthCoef * growthClamped(train[i]!));
  const ageOf = (p: SnapshotProtocol) => {
    const d = ageDays(asOf, p.listed_at);
    return d === null ? 2 : d / 365.25;
  };
  const ageCoef =
    univariateSlope(train.map((p, i) => ({ x: ageOf(p), y: residAfterGrowth[i]! }))) * shrink;
  const predict = (p: SnapshotProtocol) =>
    base(p) + offsetOf(p) + growthCoef * growthClamped(p) + ageCoef * ageOf(p);
  const residuals = new Map<string, number[]>();
  const globalResid: number[] = [];
  for (const p of train) {
    const r = Math.log(p.mcap_usd!) - predict(p);
    const key = p.category ?? '(uncategorised)';
    if (!residuals.has(key)) residuals.set(key, []);
    residuals.get(key)!.push(r);
    globalResid.push(r);
  }
  return { slope, intercept, offsets, growthCoef, ageCoef, predict, residuals, globalResid };
}

/** Deterministic three-fold cross-validation of one model variant. */
function crossValidate(samples: SnapshotProtocol[], asOf: string, shrink: number): { medianFactor: number; within2x: number; within4x: number } {
  const sorted = [...samples].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const abs: number[] = [];
  for (let fold = 0; fold < 3; fold++) {
    const train = sorted.filter((_, i) => i % 3 !== fold);
    const test = sorted.filter((_, i) => i % 3 === fold);
    const fit = fitRaw(train, asOf, shrink);
    for (const p of test) abs.push(Math.abs(Math.log(p.mcap_usd!) - fit.predict(p)));
  }
  const within = (cap: number) => abs.filter((e) => e < cap).length / abs.length;
  return { medianFactor: Math.exp(median(abs)), within2x: within(Math.LN2), within4x: within(2 * Math.LN2) };
}

// ---------------------------------------------------------------------------
// Feature context: descriptive statistics of the snapshot itself. Nothing
// here reads a market cap, so the same context serves fitting and scoring.
// ---------------------------------------------------------------------------

export interface FeatureContext {
  asOf: string;
  catMedianTvl: Map<string, number>;
  catTotalTvl: Map<string, number>;
  catCount: Map<string, number>;
  tvlAsc: number[];
  meanLogTvl: number;
}

const L2_CHAINS = ['Arbitrum', 'Base', 'Optimism', 'zkSync Era', 'Linea', 'Scroll', 'Blast', 'Mantle'];

export function buildContext(snapshot: Snapshot): FeatureContext {
  const byCat = new Map<string, number[]>();
  const catTotalTvl = new Map<string, number>();
  const catCount = new Map<string, number>();
  for (const p of snapshot.protocols) {
    const key = p.category ?? '(uncategorised)';
    if (!byCat.has(key)) byCat.set(key, []);
    if (p.tvl_usd > 0) byCat.get(key)!.push(p.tvl_usd);
    catTotalTvl.set(key, (catTotalTvl.get(key) ?? 0) + Math.max(0, p.tvl_usd));
    catCount.set(key, (catCount.get(key) ?? 0) + 1);
  }
  const catMedianTvl = new Map<string, number>();
  for (const [key, tvls] of byCat) catMedianTvl.set(key, tvls.length ? median(tvls) : 1);
  const tvlAsc = snapshot.protocols.map((p) => p.tvl_usd).sort((a, b) => a - b);
  const meanLogTvl = snapshot.protocols.reduce((s, p) => s + Math.log(Math.max(1, p.tvl_usd)), 0) / snapshot.protocols.length;
  return { asOf: snapshot.as_of, catMedianTvl, catTotalTvl, catCount, tvlAsc, meanLogTvl };
}

/** Years a protocol has been listed, with the v1 convention for no date. */
function yearsListed(p: SnapshotProtocol, asOf: string): number {
  return (ageDays(asOf, p.listed_at) ?? 730) / 365.25;
}

/** Seven-day change as a clamped fraction: +0.25 means +25%. */
function growthFrac(p: SnapshotProtocol): number {
  if (p.change_7d === null || !Number.isFinite(p.change_7d)) return 0;
  return Math.max(-100, Math.min(100, p.change_7d)) / 100;
}

function tvlPercentile(p: SnapshotProtocol, ctx: FeatureContext): number {
  let lo = 0;
  let hi = ctx.tvlAsc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ctx.tvlAsc[mid]! < p.tvl_usd) lo = mid + 1;
    else hi = mid;
  }
  return ctx.tvlAsc.length <= 1 ? 0.5 : lo / (ctx.tvlAsc.length - 1);
}

export type FeatureGroup = 'growth' | 'age' | 'other';

export interface FeatureDef {
  name: string;
  group: FeatureGroup;
  value: (p: SnapshotProtocol, ctx: FeatureContext) => number;
}

/**
 * Variant B's dictionary: 25 interpretable features, every one derived
 * from the snapshot's own fields for that protocol plus snapshot-wide
 * size context. No feature names a protocol.
 */
export const FEATURE_DEFS: FeatureDef[] = [
  { name: '7d growth, clamped ±100%', group: 'growth', value: (p) => growthFrac(p) },
  { name: 'growth squared', group: 'growth', value: (p) => growthFrac(p) ** 2 },
  { name: 'growth, positive part', group: 'growth', value: (p) => Math.max(0, growthFrac(p)) },
  { name: 'growth, negative part', group: 'growth', value: (p) => Math.min(0, growthFrac(p)) },
  { name: 'growth, absolute', group: 'growth', value: (p) => Math.abs(growthFrac(p)) },
  { name: 'log years listed', group: 'age', value: (p, ctx) => Math.log1p(yearsListed(p, ctx.asOf)) },
  { name: 'years listed, clamped', group: 'age', value: (p, ctx) => Math.min(10, yearsListed(p, ctx.asOf)) / 5 },
  { name: 'listed over 1 year', group: 'age', value: (p, ctx) => (yearsListed(p, ctx.asOf) > 1 ? 1 : 0) },
  { name: 'listed over 3 years', group: 'age', value: (p, ctx) => (yearsListed(p, ctx.asOf) > 3 ? 1 : 0) },
  { name: 'log chain count', group: 'other', value: (p) => Math.log(Math.max(1, p.chains.length)) },
  { name: 'three or more chains', group: 'other', value: (p) => (p.chains.length >= 3 ? 1 : 0) },
  { name: 'single chain', group: 'other', value: (p) => (p.chains.length <= 1 ? 1 : 0) },
  { name: 'on Ethereum', group: 'other', value: (p) => (p.chains.includes('Ethereum') ? 1 : 0) },
  { name: 'on Solana', group: 'other', value: (p) => (p.chains.includes('Solana') ? 1 : 0) },
  { name: 'on a major L2', group: 'other', value: (p) => (p.chains.some((c) => L2_CHAINS.includes(c)) ? 1 : 0) },
  { name: 'log TVL vs category median', group: 'other', value: (p, ctx) => Math.log(Math.max(1, p.tvl_usd) / Math.max(1, ctx.catMedianTvl.get(p.category ?? '(uncategorised)') ?? 1)) },
  { name: 'TVL percentile in snapshot', group: 'other', value: (p, ctx) => tvlPercentile(p, ctx) },
  { name: 'TVL percentile squared', group: 'other', value: (p, ctx) => tvlPercentile(p, ctx) ** 2 },
  { name: 'log category total TVL', group: 'other', value: (p, ctx) => Math.log(Math.max(1, ctx.catTotalTvl.get(p.category ?? '(uncategorised)') ?? 1)) },
  { name: 'log category protocol count', group: 'other', value: (p, ctx) => Math.log(Math.max(1, ctx.catCount.get(p.category ?? '(uncategorised)') ?? 1)) },
  { name: 'name length', group: 'other', value: (p) => p.name.length / 30 },
  { name: 'slug length', group: 'other', value: (p) => p.slug.length / 30 },
  { name: 'digit in name', group: 'other', value: (p) => (/\d/.test(p.name) ? 1 : 0) },
  { name: 'log TVL x growth', group: 'growth', value: (p, ctx) => (Math.log(Math.max(1, p.tvl_usd)) - ctx.meanLogTvl) * growthFrac(p) },
  { name: 'log TVL x log years listed', group: 'age', value: (p, ctx) => (Math.log(Math.max(1, p.tvl_usd)) - ctx.meanLogTvl) * Math.log1p(yearsListed(p, ctx.asOf)) },
];

function featureValues(p: SnapshotProtocol, ctx: FeatureContext): number[] {
  return FEATURE_DEFS.map((f) => f.value(p, ctx));
}

// ---------------------------------------------------------------------------
// Small deterministic linear algebra: a Gauss-Jordan solver and a ridge fit
// on standardised features. No randomness anywhere; identical inputs give
// identical outputs, which the grader's two-run rule requires.
// ---------------------------------------------------------------------------

function solveLinear(aIn: number[][], bIn: number[]): number[] {
  const n = bIn.length;
  const a = aIn.map((row) => [...row]);
  const b = [...bIn];
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    if (Math.abs(a[piv]![col]!) < 1e-12) a[piv]![col] = 1e-12;
    if (piv !== col) {
      const t = a[piv]!;
      a[piv] = a[col]!;
      a[col] = t;
      const tb = b[piv]!;
      b[piv] = b[col]!;
      b[col] = tb;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r]![col]! / a[col]![col]!;
      if (f === 0) continue;
      for (let c = col; c < n; c++) a[r]![c]! -= f * a[col]![c]!;
      b[r]! -= f * b[col]!;
    }
  }
  return b.map((v, i) => v / a[i]![i]!);
}

interface RidgeFit {
  beta: number[];
  means: number[];
  sds: number[];
  yMean: number;
}

function ridgeSolve(xs: number[][], ys: number[], lambda: number, means: number[], sds: number[], yMean: number, weights: number[]): number[] {
  const n = xs.length;
  const d = xs[0]!.length;
  const A: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const b = new Array<number>(d).fill(0);
  for (let i = 0; i < n; i++) {
    const w = weights[i]!;
    if (w === 0) continue;
    const z = xs[i]!.map((v, j) => (v - means[j]!) / sds[j]!);
    const yc = ys[i]! - yMean;
    for (let j = 0; j < d; j++) {
      b[j]! += w * z[j]! * yc;
      for (let k = 0; k < d; k++) A[j]![k]! += w * z[j]! * z[k]!;
    }
  }
  for (let j = 0; j < d; j++) A[j]![j]! += lambda;
  return solveLinear(A, b);
}

/**
 * Ridge on standardised features, with two Huber reweighting rounds: the
 * snapshot's log-space residuals are heavy-tailed (a protocol can trade
 * at 100x its curve value), and squared loss lets a handful of outliers
 * drag every coefficient. Rows whose residual exceeds 2 log units are
 * progressively downweighted, which aligns the fit with the median
 * factor the validation race scores.
 */
function ridgeFit(xs: number[][], ys: number[], lambda: number): RidgeFit {
  const n = xs.length;
  const d = xs[0]!.length;
  const means = new Array<number>(d).fill(0);
  const sds = new Array<number>(d).fill(1);
  for (let j = 0; j < d; j++) {
    let m = 0;
    for (let i = 0; i < n; i++) m += xs[i]![j]!;
    m /= n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (xs[i]![j]! - m) ** 2;
    means[j] = m;
    const sd = Math.sqrt(v / n);
    sds[j] = sd > 1e-9 ? sd : 1;
  }
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let weights = new Array<number>(n).fill(1);
  let beta = ridgeSolve(xs, ys, lambda, means, sds, yMean, weights);
  for (let round = 0; round < 2; round++) {
    weights = xs.map((row, i) => {
      let pred = yMean;
      for (let j = 0; j < d; j++) pred += (beta[j]! * (row[j]! - means[j]!)) / sds[j]!;
      const r = Math.abs(ys[i]! - pred);
      return r <= 2 ? 1 : 2 / r;
    });
    beta = ridgeSolve(xs, ys, lambda, means, sds, yMean, weights);
  }
  return { beta, means, sds, yMean };
}

function ridgeContribs(fit: RidgeFit, x: number[]): number[] {
  return x.map((v, j) => (fit.beta[j]! * (v - fit.means[j]!)) / fit.sds[j]!);
}

// ---------------------------------------------------------------------------
// The three value-model variants. Every predictor decomposes its log-space
// answer into base / category / growth / age / other, so the dashboard's
// detail view can show the arithmetic of any row under any variant.
// ---------------------------------------------------------------------------

export interface Prediction {
  log: number;
  base: number;
  category: number;
  growth: number;
  age: number;
  other: number;
}

export interface ValuePredictor {
  predict: (p: SnapshotProtocol) => Prediction;
  categories: CategoryFit[];
  lambda: number | null;
  featureCount: number;
}

function categoryTable(offsets: Map<string, { n: number; offset: number; raw: number }>, slopes: Map<string, number | null>): CategoryFit[] {
  return [...offsets.entries()]
    .map(([category, v]) => ({
      category,
      samples: v.n,
      offset: v.offset,
      rawMedianResidual: v.raw,
      impliedMultiple: Math.exp(v.offset),
      slope: slopes.get(category) ?? null,
    }))
    .sort((a, b) => b.samples - a.samples || (a.category < b.category ? -1 : 1));
}

/** Variant A: the v1 form, kept as a racing baseline and blend ingredient. */
function fitVariantA(train: SnapshotProtocol[], asOf: string): ValuePredictor {
  const raw = fitRaw(train, asOf, ADJUSTMENT_SHRINK);
  const offsetOf = (p: SnapshotProtocol) => raw.offsets.get(p.category ?? '(uncategorised)')?.offset ?? 0;
  return {
    predict: (p) => {
      const base = raw.intercept + raw.slope * Math.log(p.tvl_usd);
      const category = offsetOf(p);
      const growth = raw.growthCoef * growthClamped(p);
      const age = raw.ageCoef * yearsListed(p, asOf);
      return { log: base + category + growth + age, base, category, growth, age, other: 0 };
    },
    categories: categoryTable(raw.offsets, new Map()),
    lambda: null,
    featureCount: 4 + raw.offsets.size,
  };
}

const SLOPE_MIN_SAMPLES = 6;
const SLOPE_SHRINK = 16;

/**
 * Variant B: variant A's structure, extended. A per-category slope
 * deviation (the category's residuals regressed on TVL centred at the
 * category's own mean, shrunk n/(n+10)) lets big categories tilt the
 * curve instead of only shifting it, and the 25-feature ridge dictionary
 * is fitted on whatever A plus the slope deviations still miss, so the
 * dictionary only has to explain the simple model's leftovers. Its
 * penalty is chosen by inner cross-validation over a wide grid, with
 * heavy penalties that nearly switch the dictionary off always available.
 */
function fitVariantB(train: SnapshotProtocol[], asOf: string, ctx: FeatureContext, lambda: number): ValuePredictor {
  const raw = fitRaw(train, asOf, ADJUSTMENT_SHRINK);
  const offsetOf = (p: SnapshotProtocol) => raw.offsets.get(p.category ?? '(uncategorised)')?.offset ?? 0;
  const byCat = new Map<string, SnapshotProtocol[]>();
  for (const p of train) {
    const key = p.category ?? '(uncategorised)';
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key)!.push(p);
  }
  const slopeDevs = new Map<string, { dev: number; meanLogTvl: number }>();
  const slopes = new Map<string, number | null>();
  for (const [key, rows] of byCat) {
    if (rows.length < SLOPE_MIN_SAMPLES) {
      slopes.set(key, null);
      continue;
    }
    const meanLogTvl = rows.reduce((s, p) => s + Math.log(p.tvl_usd), 0) / rows.length;
    let sxy = 0;
    let sxx = 0;
    for (const p of rows) {
      const dx = Math.log(p.tvl_usd) - meanLogTvl;
      sxy += dx * (Math.log(p.mcap_usd!) - raw.predict(p));
      sxx += dx * dx;
    }
    if (sxx < 1e-9) {
      slopes.set(key, null);
      continue;
    }
    const dev = (rows.length / (rows.length + SLOPE_SHRINK)) * (sxy / sxx);
    slopeDevs.set(key, { dev, meanLogTvl });
    slopes.set(key, raw.slope + dev);
  }
  const slopeAdj = (p: SnapshotProtocol) => {
    const s = slopeDevs.get(p.category ?? '(uncategorised)');
    return s ? s.dev * (Math.log(p.tvl_usd) - s.meanLogTvl) : 0;
  };
  const ridge = ridgeFit(
    train.map((p) => featureValues(p, ctx)),
    train.map((p) => Math.log(p.mcap_usd!) - raw.predict(p) - slopeAdj(p)),
    lambda,
  );
  return {
    predict: (p) => {
      const base = raw.intercept + raw.slope * Math.log(p.tvl_usd);
      const category = offsetOf(p) + slopeAdj(p);
      const contribs = ridgeContribs(ridge, featureValues(p, ctx));
      let growth = raw.growthCoef * growthClamped(p);
      let age = raw.ageCoef * yearsListed(p, asOf);
      let other = ridge.yMean;
      FEATURE_DEFS.forEach((f, j) => {
        if (f.group === 'growth') growth += contribs[j]!;
        else if (f.group === 'age') age += contribs[j]!;
        else other += contribs[j]!;
      });
      return { log: base + category + growth + age + other, base, category, growth, age, other };
    },
    categories: categoryTable(raw.offsets, slopes),
    lambda,
    featureCount: 4 + raw.offsets.size + slopeDevs.size + FEATURE_DEFS.length,
  };
}

/** Variant C: the log-space average of A and B. */
function fitBlend(a: ValuePredictor, b: ValuePredictor): ValuePredictor {
  return {
    predict: (p) => {
      const pa = a.predict(p);
      const pb = b.predict(p);
      return {
        log: (pa.log + pb.log) / 2,
        base: (pa.base + pb.base) / 2,
        category: (pa.category + pb.category) / 2,
        growth: (pa.growth + pb.growth) / 2,
        age: (pa.age + pb.age) / 2,
        other: (pa.other + pb.other) / 2,
      };
    },
    categories: b.categories,
    lambda: b.lambda,
    featureCount: a.featureCount + b.featureCount,
  };
}

function medianFactor(predict: (p: SnapshotProtocol) => Prediction, test: SnapshotProtocol[]): number {
  return Math.exp(median(test.map((p) => Math.abs(Math.log(p.mcap_usd!) - predict(p).log))));
}

/** Slug-ordered three-fold score of one fitter, the race's reference column. */
function threeFoldFactor(fitter: (train: SnapshotProtocol[]) => ValuePredictor, priced: SnapshotProtocol[]): number {
  const sorted = [...priced].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const errs: number[] = [];
  for (let fold = 0; fold < 3; fold++) {
    const train = sorted.filter((_, i) => i % 3 !== fold);
    const test = sorted.filter((_, i) => i % 3 === fold);
    const predictor = fitter(train);
    for (const p of test) errs.push(Math.abs(Math.log(p.mcap_usd!) - predictor.predict(p).log));
  }
  return Math.exp(median(errs));
}

const LAMBDA_GRID = [1, 3, 10, 30, 100, 300, 1000];

/** Variant B's ridge penalty, chosen by inner three-fold CV on the train set alone. */
function chooseLambdaB(train: SnapshotProtocol[], asOf: string, ctx: FeatureContext): number {
  let best = LAMBDA_GRID[3]!;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const lam of LAMBDA_GRID) {
    const score = threeFoldFactor((tr) => fitVariantB(tr, asOf, ctx, lam), train);
    if (score < bestScore - 1e-12) {
      bestScore = score;
      best = lam;
    }
  }
  return best;
}

interface Split {
  train: SnapshotProtocol[];
  test: SnapshotProtocol[];
}

/**
 * The outer splits the race is judged on. Walk-forwards order the dated
 * comparables by listing date and expand the training window; comparables
 * with no listing date always train and are never scored out of time. The
 * blind holdout is every fourth comparable in slug order.
 */
function outerSplits(priced: SnapshotProtocol[]): { wf1: Split; wf2: Split; blind: Split } {
  const dated = priced
    .filter((p) => p.listed_at !== null)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1));
  const undated = priced.filter((p) => p.listed_at === null);
  const cut1 = Math.floor(dated.length * 0.5);
  const cut2 = Math.floor(dated.length * 0.75);
  const bySlug = [...priced].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return {
    wf1: { train: [...undated, ...dated.slice(0, cut1)], test: dated.slice(cut1, cut2) },
    wf2: { train: [...undated, ...dated.slice(0, cut2)], test: dated.slice(cut2) },
    blind: { train: bySlug.filter((_, i) => i % 4 !== 3), test: bySlug.filter((_, i) => i % 4 === 3) },
  };
}

export interface ValueModel {
  fit: ModelFit;
  predictor: ValuePredictor;
  residByCat: Map<string, number[]>;
}

/** Race the variants on held-out data, then refit the winner on everything. */
export function fitAll(snapshot: Snapshot): ValueModel {
  const ctx = buildContext(snapshot);
  const asOf = snapshot.as_of;
  const priced = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const unpricedListed = snapshot.protocols.filter((p) => !recordsNoToken(p) && (p.mcap_usd === null || p.mcap_usd <= 0)).length;
  const fitA = (tr: SnapshotProtocol[]) => fitVariantA(tr, asOf);
  const fitB = (tr: SnapshotProtocol[]) => fitVariantB(tr, asOf, ctx, chooseLambdaB(tr, asOf, ctx));
  const fitC = (tr: SnapshotProtocol[]) => fitBlend(fitA(tr), fitB(tr));
  const racers = [
    { key: 'A: TVL curve + category offsets, growth & age at 1/4 strength (v1 form)', fit: fitA },
    { key: 'B: A + per-category slope deviations + 25-feature ridge', fit: fitB },
    { key: 'C: blend of A and B', fit: fitC },
  ];
  const splits = outerSplits(priced);
  const validation: ValidationRow[] = racers.map((r) => {
    const walkForward1 = medianFactor(r.fit(splits.wf1.train).predict, splits.wf1.test);
    const walkForward2 = medianFactor(r.fit(splits.wf2.train).predict, splits.wf2.test);
    const blind = medianFactor(r.fit(splits.blind.train).predict, splits.blind.test);
    const threeFold = threeFoldFactor(r.fit, priced);
    return {
      variant: r.key,
      walkForward1,
      walkForward2,
      blind,
      threeFold,
      mean: (walkForward1 + walkForward2 + blind) / 3,
      chosen: false,
    };
  });
  // Parsimony order on ties: A before C before B.
  let winner = 0;
  for (const idx of [0, 2, 1]) {
    if (validation[idx]!.mean < validation[winner]!.mean - 1e-12) winner = idx;
  }
  validation[winner]!.chosen = true;
  const predictor = racers[winner]!.fit(priced);
  const residByCat = new Map<string, number[]>();
  const globalResid: number[] = [];
  for (const p of priced) {
    const r = Math.log(p.mcap_usd!) - predictor.predict(p).log;
    const key = p.category ?? '(uncategorised)';
    if (!residByCat.has(key)) residByCat.set(key, []);
    residByCat.get(key)!.push(r);
    globalResid.push(r);
  }
  const rawA = fitRaw(priced, asOf, ADJUSTMENT_SHRINK);
  const cvLevel = crossValidate(priced, asOf, 0);
  const cvApplied = crossValidate(priced, asOf, ADJUSTMENT_SHRINK);
  const cvFull = crossValidate(priced, asOf, 1);
  const launch = fitLaunchModel(snapshot);
  const fit: ModelFit = {
    samples: priced.length,
    unpricedListed,
    variant: racers[winner]!.key,
    featureCount: predictor.featureCount,
    featureNames: FEATURE_DEFS.map((f) => f.name),
    lambda: predictor.lambda,
    slope: rawA.slope,
    intercept: rawA.intercept,
    growthCoef: rawA.growthCoef,
    ageCoef: rawA.ageCoef,
    categories: predictor.categories,
    residQ25: quartile(globalResid, 0.25),
    residQ75: quartile(globalResid, 0.75),
    validation,
    cv: [
      { variant: 'TVL curve + category offsets only', medianFactor: cvLevel.medianFactor, within2xPct: cvLevel.within2x * 100, within4xPct: cvLevel.within4x * 100 },
      { variant: 'plus growth & track-record terms at 1/4 strength (variant A)', medianFactor: cvApplied.medianFactor, within2xPct: cvApplied.within2x * 100, within4xPct: cvApplied.within4x * 100 },
      { variant: 'plus growth & track-record terms at full strength', medianFactor: cvFull.medianFactor, within2xPct: cvFull.within2x * 100, within4xPct: cvFull.within4x * 100 },
    ],
    holdoutMedianFactor: validation[winner]!.mean,
    launch: launch.info,
  };
  return { fit, predictor, residByCat };
}

export interface Implied {
  value: number;
  low: number;
  high: number;
  baseLog: number;
  categoryOffset: number;
  growthAdj: number;
  ageAdj: number;
  otherAdj: number;
  multiple: number; // value / tvl
}

/** One protocol's implied value and the decomposition behind it. */
export function impliedFor(p: SnapshotProtocol, vm: ValueModel): Implied {
  const fit = vm.fit;
  const pred = vm.predictor.predict(p);
  const catResid = vm.residByCat.get(p.category ?? '(uncategorised)');
  const w = catResid ? catResid.length / (catResid.length + CATEGORY_SHRINK) : 0;
  const q25 = catResid ? w * quartile(catResid, 0.25) + (1 - w) * fit.residQ25 : fit.residQ25;
  const q75 = catResid ? w * quartile(catResid, 0.75) + (1 - w) * fit.residQ75 : fit.residQ75;
  const value = Math.max(1, Math.round(Math.exp(pred.log)));
  return {
    value,
    low: Math.max(1, Math.round(Math.exp(pred.log + q25))),
    high: Math.round(Math.exp(pred.log + q75)),
    baseLog: pred.base,
    categoryOffset: pred.category,
    growthAdj: pred.growth,
    ageAdj: pred.age,
    otherAdj: pred.other,
    multiple: value / p.tvl_usd,
  };
}

// ---------------------------------------------------------------------------
// The launch-odds model. The outcome is the snapshot's own record: whether
// a protocol has a token at all. A logistic regression (IRLS, ridge 1.0 on
// standardised features, iterated to a fixed tolerance) over log TVL, log
// years listed, chain count, seven-day growth and the category's launch
// rate among its peers in the training set, shrunk toward the global rate
// so thin categories barely move the odds.
// ---------------------------------------------------------------------------

export interface LaunchModel {
  info: LaunchFitInfo;
  predict: (p: SnapshotProtocol) => number;
}

const LAUNCH_FEATURE_NAMES = ['log TVL', 'log years listed', 'chain count', '7d growth', "category's launch rate among peers"];
const LAUNCH_CAT_SHRINK = 8;

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
}

function launchCatRates(train: SnapshotProtocol[]): { rates: Map<string, number>; global: number } {
  let launched = 0;
  const counts = new Map<string, { launched: number; total: number }>();
  for (const p of train) {
    const y = recordsNoToken(p) ? 0 : 1;
    launched += y;
    const key = p.category ?? '(uncategorised)';
    if (!counts.has(key)) counts.set(key, { launched: 0, total: 0 });
    const c = counts.get(key)!;
    c.launched += y;
    c.total += 1;
  }
  const global = train.length ? launched / train.length : 0.5;
  const rates = new Map<string, number>();
  for (const [key, c] of counts) rates.set(key, (c.launched + LAUNCH_CAT_SHRINK * global) / (c.total + LAUNCH_CAT_SHRINK));
  return { rates, global };
}

function launchRawFeatures(p: SnapshotProtocol, asOf: string, catRate: number): number[] {
  return [
    Math.log10(Math.max(1, p.tvl_usd)),
    Math.log1p(yearsListed(p, asOf)),
    Math.min(10, p.chains.length),
    growthFrac(p),
    catRate,
  ];
}

function fitLaunch(train: SnapshotProtocol[], asOf: string): { predict: (p: SnapshotProtocol) => number } {
  const { rates, global } = launchCatRates(train);
  const rateOf = (p: SnapshotProtocol) => rates.get(p.category ?? '(uncategorised)') ?? global;
  const X = train.map((p) => launchRawFeatures(p, asOf, rateOf(p)));
  const y = train.map((p) => (recordsNoToken(p) ? 0 : 1));
  const n = X.length;
  const d = X[0]!.length;
  const means = new Array<number>(d).fill(0);
  const sds = new Array<number>(d).fill(1);
  for (let j = 0; j < d; j++) {
    let m = 0;
    for (let i = 0; i < n; i++) m += X[i]![j]!;
    m /= n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (X[i]![j]! - m) ** 2;
    means[j] = m;
    const sd = Math.sqrt(v / n);
    sds[j] = sd > 1e-9 ? sd : 1;
  }
  const Z = X.map((row) => row.map((v, j) => (v - means[j]!) / sds[j]!));
  let b0 = Math.log(Math.max(1e-6, Math.min(1 - 1e-6, global)) / (1 - Math.max(1e-6, Math.min(1 - 1e-6, global))));
  let beta = new Array<number>(d).fill(0);
  const RIDGE = 1.0;
  for (let iter = 0; iter < 200; iter++) {
    const g = new Array<number>(d + 1).fill(0);
    const H: number[][] = Array.from({ length: d + 1 }, () => new Array<number>(d + 1).fill(0));
    for (let i = 0; i < n; i++) {
      let eta = b0;
      for (let j = 0; j < d; j++) eta += beta[j]! * Z[i]![j]!;
      const mu = sigmoid(eta);
      const w = Math.max(1e-6, mu * (1 - mu));
      const r = y[i]! - mu;
      const row = [1, ...Z[i]!];
      for (let a = 0; a <= d; a++) {
        g[a]! += row[a]! * r;
        for (let b = 0; b <= d; b++) H[a]![b]! += w * row[a]! * row[b]!;
      }
    }
    for (let j = 0; j < d; j++) {
      g[j + 1]! -= RIDGE * beta[j]!;
      H[j + 1]![j + 1]! += RIDGE;
    }
    const step = solveLinear(H, g);
    let maxStep = 0;
    b0 += step[0]!;
    for (let j = 0; j < d; j++) {
      beta[j]! += step[j + 1]!;
      maxStep = Math.max(maxStep, Math.abs(step[j + 1]!));
    }
    maxStep = Math.max(maxStep, Math.abs(step[0]!));
    if (maxStep < 1e-10) break;
  }
  return {
    predict: (p) => {
      const x = launchRawFeatures(p, asOf, rateOf(p));
      let eta = b0;
      for (let j = 0; j < d; j++) eta += beta[j]! * ((x[j]! - means[j]!) / sds[j]!);
      return sigmoid(eta);
    },
  };
}

/** Rank-based AUC with average ranks for ties. */
function aucScore(scores: number[], ys: number[]): number {
  const order = scores.map((s, i) => ({ s, y: ys[i]! })).sort((a, b) => a.s - b.s);
  const ranks = new Array<number>(order.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.s === order[i]!.s) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    i = j + 1;
  }
  let rankSumPos = 0;
  let nPos = 0;
  let nNeg = 0;
  order.forEach((o, k) => {
    if (o.y === 1) {
      rankSumPos += ranks[k]!;
      nPos++;
    } else nNeg++;
  });
  if (nPos === 0 || nNeg === 0) return 0.5;
  return (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/** Fit the production launch model on all protocols; score it on a blind holdout. */
export function fitLaunchModel(snapshot: Snapshot): LaunchModel {
  const asOf = snapshot.as_of;
  const bySlug = [...snapshot.protocols].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const test = bySlug.filter((_, i) => i % 4 === 3);
  const train = bySlug.filter((_, i) => i % 4 !== 3);
  const holdout = fitLaunch(train, asOf);
  const scores = test.map((p) => holdout.predict(p));
  const ys = test.map((p) => (recordsNoToken(p) ? 0 : 1));
  const auc = aucScore(scores, ys);
  const brier = scores.reduce((s, v, i) => s + (v - ys[i]!) ** 2, 0) / scores.length;
  const prod = fitLaunch(snapshot.protocols, asOf);
  const launched = snapshot.protocols.filter((p) => !recordsNoToken(p)).length;
  return {
    info: {
      samples: snapshot.protocols.length,
      launched,
      baseRate: launched / snapshot.protocols.length,
      auc,
      brier,
      features: LAUNCH_FEATURE_NAMES,
    },
    predict: prod.predict,
  };
}

// ---------------------------------------------------------------------------
// The peer record behind each row's odds: raw launched shares for the
// protocol's own category, age band and TVL band, counted over the whole
// snapshot. Counts, not just rates, so a reader can see the sample behind
// every number.
// ---------------------------------------------------------------------------

export interface PeerBand {
  label: string;
  launched: number;
  total: number;
  rate: number;
}

export interface PeerRecord {
  category: PeerBand;
  age: PeerBand;
  tvl: PeerBand;
}

const AGE_BANDS: { label: string; test: (years: number | null) => boolean }[] = [
  { label: 'no listing date recorded', test: (y) => y === null },
  { label: 'listed under 6 months', test: (y) => y !== null && y < 0.5 },
  { label: 'listed 6-12 months', test: (y) => y !== null && y >= 0.5 && y < 1 },
  { label: 'listed 1-2 years', test: (y) => y !== null && y >= 1 && y < 2 },
  { label: 'listed 2-4 years', test: (y) => y !== null && y >= 2 && y < 4 },
  { label: 'listed over 4 years', test: (y) => y !== null && y >= 4 },
];

const TVL_BANDS: { label: string; test: (tvl: number) => boolean }[] = [
  { label: 'TVL under $10M', test: (t) => t < 10_000_000 },
  { label: 'TVL $10-50M', test: (t) => t >= 10_000_000 && t < 50_000_000 },
  { label: 'TVL $50-100M', test: (t) => t >= 50_000_000 && t < 100_000_000 },
  { label: 'TVL $100-500M', test: (t) => t >= 100_000_000 && t < 500_000_000 },
  { label: 'TVL over $500M', test: (t) => t >= 500_000_000 },
];

function bandOf<T>(bands: { label: string; test: (v: T) => boolean }[], v: T): number {
  const at = bands.findIndex((b) => b.test(v));
  return at < 0 ? 0 : at;
}

/** Precompute the band counts once, then answer any protocol's peer record. */
export function buildPeerIndex(snapshot: Snapshot): (p: SnapshotProtocol) => PeerRecord {
  const asOf = snapshot.as_of;
  const yearsOf = (p: SnapshotProtocol) => {
    const d = ageDays(asOf, p.listed_at);
    return d === null ? null : d / 365.25;
  };
  const tally = (keyOf: (p: SnapshotProtocol) => string) => {
    const map = new Map<string, { launched: number; total: number }>();
    for (const p of snapshot.protocols) {
      const key = keyOf(p);
      if (!map.has(key)) map.set(key, { launched: 0, total: 0 });
      const c = map.get(key)!;
      c.total += 1;
      if (!recordsNoToken(p)) c.launched += 1;
    }
    return map;
  };
  const catMap = tally((p) => p.category ?? '(uncategorised)');
  const ageMap = tally((p) => AGE_BANDS[bandOf(AGE_BANDS, yearsOf(p))]!.label);
  const tvlMap = tally((p) => TVL_BANDS[bandOf(TVL_BANDS, p.tvl_usd)]!.label);
  const band = (map: Map<string, { launched: number; total: number }>, label: string): PeerBand => {
    const c = map.get(label) ?? { launched: 0, total: 0 };
    return { label, launched: c.launched, total: c.total, rate: c.total ? c.launched / c.total : 0 };
  };
  return (p) => ({
    category: band(catMap, p.category ?? '(uncategorised)'),
    age: band(ageMap, AGE_BANDS[bandOf(AGE_BANDS, yearsOf(p))]!.label),
    tvl: band(tvlMap, TVL_BANDS[bandOf(TVL_BANDS, p.tvl_usd)]!.label),
  });
}

export function parseSnapshot(text: string): Snapshot {
  const data = JSON.parse(text) as Snapshot;
  if (!Array.isArray(data.protocols) || !Array.isArray(data.watchlist)) {
    throw new Error('snapshot is missing its protocols or watchlist');
  }
  return data;
}

// ---------------------------------------------------------------------------
// Farm plans. Every plan is generated from the protocol's own snapshot
// figures: its category picks the template, its chains pick the network and
// the gas price of an action, its TVL picks the capital tier a reader would
// sensibly put to work, and its age picks the programme length. Each step
// states the action, what it costs and how long it takes; the plan's totals
// are summed from the same numbers the step text quotes.
// ---------------------------------------------------------------------------

/** Rough mainnet-era gas cost of one on-chain action, in dollars, by chain. */
const GAS_USD: Record<string, number> = {
  Ethereum: 14,
  Solana: 0.03,
  Base: 0.12,
  Arbitrum: 0.35,
  Optimism: 0.25,
  Polygon: 0.04,
  BSC: 0.18,
  Avalanche: 0.28,
  'zkSync Era': 0.2,
  Linea: 0.15,
  Scroll: 0.18,
  Mantle: 0.05,
  Fantom: 0.05,
  Gnosis: 0.02,
  Celo: 0.01,
  Bitcoin: 1.2,
};

function gasFor(chain: string): number {
  return GAS_USD[chain] ?? 0.8;
}

function capitalTier(tvl: number): { low: number; high: number } {
  if (tvl >= 500_000_000) return { low: 2000, high: 5000 };
  if (tvl >= 100_000_000) return { low: 1000, high: 2500 };
  if (tvl >= 25_000_000) return { low: 500, high: 1500 };
  return { low: 250, high: 750 };
}

function money(n: number): string {
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (n >= 10) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

export interface FarmPlan {
  steps: string[];
  capitalUsd: number;
  costUsd: number; // gas and fees over the whole programme, capital excluded
  hours: number; // reader time over the whole programme
  weeks: number;
}

/** The two or three core actions for a category, as [action, sessions] pairs. */
function coreActions(category: string | null, name: string): { text: string; sessions: number; minutes: number }[] {
  const c = category ?? '';
  const dex = [
    { text: `Swap both ways in ${name}'s two deepest pairs, keeping each trade between $100 and $400 so volume is real without paying spread for nothing`, sessions: 6, minutes: 15 },
    { text: `Add a balanced liquidity position to ${name}'s flagship pool and leave it untouched between weekly checks, withdrawing only if the pool's share of protocol TVL falls for two straight weeks`, sessions: 4, minutes: 20 },
  ];
  const lend = [
    { text: `Supply blue-chip collateral (ETH or a major stablecoin) to ${name}'s main market and keep the position open; size it so a 30% price drop cannot liquidate you`, sessions: 3, minutes: 20 },
    { text: `Borrow a small amount against the collateral, hold it two to three days, then repay in full; repeat the cycle monthly so the account shows genuine two-sided use`, sessions: 6, minutes: 10 },
  ];
  const stake = [
    { text: `Stake the chain's native asset through ${name} in one transaction and keep the receipt token in the same wallet, unstaked elsewhere, so the holding period is unambiguous`, sessions: 2, minutes: 15 },
    { text: `Put the receipt token to one conservative second use ${name} supports (a lending market or a paired pool) and rebalance it at the weekly check rather than chasing yield daily`, sessions: 4, minutes: 15 },
  ];
  const bridge = [
    { text: `Bridge funds across two of the routes ${name} serves, in both directions, using two different assets; keep each crossing between $200 and $600`, sessions: 6, minutes: 15 },
    { text: `Leave a working balance on the far chain for a full week before bridging back, so the activity reads as use rather than round-trip farming`, sessions: 4, minutes: 10 },
  ];
  const vault = [
    { text: `Deposit into ${name}'s flagship vault on its main chain and hold the vault share token; do not split the deposit across more than two vaults`, sessions: 3, minutes: 15 },
    { text: `Compound whatever the vault pays out back into the same vault at the weekly check, and rotate to the protocol's second vault once, midway, to register use of both`, sessions: 5, minutes: 10 },
  ];
  const deriv = [
    { text: `Open small hedged perpetual positions on ${name} (long and short legs within a day of each other), sized under $300 of margin, and close them inside a week`, sessions: 6, minutes: 20 },
    { text: `Place resting limit orders instead of only market orders in half the sessions, so the account shows maker as well as taker flow`, sessions: 4, minutes: 10 },
  ];
  const cdp = [
    { text: `Open a collateralised position on ${name} at a conservative ratio (at least 200% collateralised) and mint a modest amount of its stablecoin`, sessions: 3, minutes: 20 },
    { text: `Hold part of the minted stablecoin in ${name}'s own stability or savings module, and repay and redraw once midway through the programme`, sessions: 4, minutes: 15 },
  ];
  const generic = [
    { text: `Use ${name}'s core product on its main chain the way a normal user would: one real position, held open, rather than a burst of same-day transactions`, sessions: 5, minutes: 20 },
    { text: `Return weekly to adjust or top up the position by a small amount, and take part in any governance vote or forum poll the protocol runs in that window`, sessions: 5, minutes: 10 },
  ];
  switch (c) {
    case 'Dexs': return dex;
    case 'Lending': case 'Uncollateralized Lending': case 'Collateral Markets': return lend;
    case 'Liquid Staking': case 'Staking Pool': case 'Restaking': case 'Liquid Restaking': case 'Restaked BTC': return stake;
    case 'Bridge': case 'Cross Chain Bridge': case 'Canonical Bridge': return bridge;
    case 'Yield': case 'Yield Aggregator': case 'Leveraged Farming': case 'Farm': case 'Liquidity Manager': case 'Options Vault': return vault;
    case 'Derivatives': case 'Interest Rate Derivatives': case 'Options': return deriv;
    case 'CDP': case 'CDP Manager': case 'Algo-Stables': case 'Dual-Token Stablecoin': case 'Stablecoin Issuer': case 'Stablecoin Wrapper': return cdp;
    case 'Risk Curators': case 'Onchain Capital Allocator':
      return [
        { text: `Deposit into one flagship curated vault ${name} lists on its main chain, choosing the vault whose underlying markets you can name; keep the vault receipt in the farming wallet`, sessions: 3, minutes: 20 },
        { text: `Place a second, smaller deposit in a vault run under a different curator strategy on ${name}, and read the curator's risk notes or allocation report at each monthly check so both curator styles register considered use`, sessions: 4, minutes: 15 },
      ];
    case 'RWA':
      return [
        { text: `Complete whatever onboarding ${name} offers to retail users and subscribe a first position in its shortest-duration asset, sized at the plan's capital floor`, sessions: 2, minutes: 30 },
        { text: `Hold the position to its first distribution or maturity window rather than exiting early, and add a second smaller subscription midway`, sessions: 2, minutes: 15 },
      ];
    case 'Launchpad':
      return [
        { text: `Register on ${name}, complete its identity steps, and join the whitelist or allocation process for one live sale without depositing more than the plan's capital`, sessions: 3, minutes: 25 },
        { text: `Take part in one sale at a modest size and hold the allocation rather than flipping it on the first day`, sessions: 2, minutes: 15 },
      ];
    case 'Prediction Market':
      return [
        { text: `Take small positions ($25 to $75) on ${name}'s most liquid markets each week, on both sides of different questions, and let them settle`, sessions: 6, minutes: 15 },
        { text: `Provide a standing quote on one mid-liquidity market and refresh it at the weekly check`, sessions: 4, minutes: 10 },
      ];
    case 'Insurance':
      return [
        { text: `Buy one small cover policy through ${name} on a position you actually hold elsewhere, sized to the real exposure rather than the maximum offered`, sessions: 2, minutes: 20 },
        { text: `Renew or extend the cover once at its first expiry so the account shows continuing use`, sessions: 1, minutes: 15 },
      ];
    case 'Privacy':
      return [
        { text: `Make a modest shielded deposit through ${name} and one shielded transfer, keeping amounts ordinary and the notes backed up offline`, sessions: 3, minutes: 20 },
        { text: `Withdraw part of the balance after several weeks rather than the same day, so holding time is part of the record`, sessions: 2, minutes: 15 },
      ];
    case 'Payments': case 'Crypto Card Issuer':
      return [
        { text: `Activate ${name}'s account or card product, fund it with a working balance, and route ordinary recurring spending through it`, sessions: 3, minutes: 20 },
        { text: `Keep the product in weekly use for the whole programme; payment products measure continuity, not bursts`, sessions: 6, minutes: 5 },
      ];
    default: return generic;
  }
}

/** Build one protocol's farm plan from its own snapshot figures. */
export function farmPlan(p: SnapshotProtocol, snapshot: Snapshot): FarmPlan {
  const mainChain = p.chains[0] ?? 'Ethereum';
  const gas = gasFor(mainChain);
  const cap = capitalTier(p.tvl_usd);
  const age = ageDays(snapshot.as_of, p.listed_at);
  const weeks = age === null ? 10 : age > 730 ? 8 : age > 365 ? 10 : 12;
  const cores = coreActions(p.category, p.name);
  const steps: string[] = [];
  let cost = 0;
  let minutes = 0;
  const addCost = (actions: number) => { cost += actions * gas; };

  steps.push(
    `Set up one wallet dedicated to ${p.name} and fund it on ${mainChain} with ${money(cap.low)} to ${money(cap.high)} of working capital; at ${p.tvl_usd >= 1e9 ? 'its' : 'this protocol\'s'} scale that is a realistic user position, not dust. Cost: about ${money(gas * 2)} in network fees for funding and approval. Time: about 25 minutes, once.`,
  );
  minutes += 25;
  addCost(2);
  for (const core of cores) {
    steps.push(
      `${core.text}. Repeat across ${core.sessions} sessions over the programme. Cost: about ${money(gas)} per session in network fees. Time: about ${core.minutes} minutes per session.`,
    );
    minutes += core.sessions * core.minutes;
    addCost(core.sessions);
  }
  steps.push(
    `Keep a weekly rhythm for ${weeks} weeks: one check-in to confirm the position is intact, TVL has not fallen off a cliff (the snapshot shows ${p.change_7d === null ? 'no seven-day figure reported' : `${p.change_7d.toFixed(2)}% over the last seven days`}), and no launch announcement has landed. Cost: about ${money(gas)} when a session needs a transaction. Time: about 10 minutes a week.`,
  );
  minutes += weeks * 10;
  addCost(Math.ceil(weeks / 2));
  steps.push(
    `Stay claim-ready from week ${Math.max(2, weeks - 2)}: keep the wallet's history exportable, watch ${p.name}'s official channels for a token or points announcement, and do not consolidate funds out of the farming wallet until any snapshot date has passed. Cost: no network fees. Time: about 5 minutes a week of watching.`,
  );
  minutes += weeks * 5;
  const totalCost = Math.round(cost * 100) / 100;
  steps.push(
    `Programme totals for ${p.name}: ${money(cap.low)} to ${money(cap.high)} of capital at work, about ${money(totalCost)} of network fees over ${weeks} weeks, and about ${(minutes / 60).toFixed(1)} hours of your time. Stop early if the protocol announces its token with a snapshot date already past, or if TVL halves from the ${money(p.tvl_usd)} the snapshot records.`,
  );
  return { steps, capitalUsd: cap.high, costUsd: totalCost, hours: Math.round((minutes / 60) * 10) / 10, weeks };
}

// ---------------------------------------------------------------------------
// The board and the dashboard's data.
// ---------------------------------------------------------------------------

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

export type Verdict = 'go' | 'selective' | 'skip';

export interface RadarRow extends BoardRow {
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  implied_low_usd: number;
  implied_high_usd: number;
  multiple: number;
  parts: { base: number; category: number; growth: number; age: number; other: number };
  launch_prob: number;
  expected_value_usd: number;
  verdict: Verdict;
  efficiency: number; // probability-weighted value per $1 of full plan cost
  odds: PeerRecord;
  farm_cost_usd: number;
  farm_hours: number;
  farm_capital_usd: number;
  farm_weeks: number;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  counts: { protocols: number; preToken: number; eligible: number; pricedComps: number; unpricedListed: number; watchlist: number; boardRows: number };
  excluded: { cex: number; canonicalBridge: number; versionedOrWrappedName: number; exchangeName: number; oneChainBridge: number; noTvl: number };
  model: {
    samples: number;
    variant: string;
    featureCount: number;
    featureNames: string[];
    lambda: number | null;
    slope: number;
    intercept: number;
    growthCoefPerPct: number;
    ageCoefPerYear: number;
    shrink: number;
    residQ25: number;
    residQ75: number;
    holdoutMedianFactor: number;
    validation: { variant: string; walkForward1: number; walkForward2: number; blind: number; threeFold: number; mean: number; chosen: boolean }[];
    cv: CvRow[];
    categories: { category: string; samples: number; multiple: number; slope: number | null }[];
    launch: LaunchFitInfo;
    verdicts: { go: number; selective: number; skip: number; medianEfficiency: number; p25Efficiency: number; p90Efficiency: number; timeUsdPerHour: number };
  };
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why each no-token protocol was kept off the board, counted for the method panel. */
function exclusionCounts(snapshot: Snapshot): RadarData['excluded'] {
  const out = { cex: 0, canonicalBridge: 0, versionedOrWrappedName: 0, exchangeName: 0, oneChainBridge: 0, noTvl: 0 };
  for (const p of snapshot.protocols) {
    if (!recordsNoToken(p)) continue;
    if (p.category === 'CEX') out.cex++;
    else if (p.category === 'Canonical Bridge') out.canonicalBridge++;
    else if (VERSIONED.test(p.name) || WRAPPED_WORD.test(p.name)) out.versionedOrWrappedName++;
    else if (EXCHANGE_PREFIX.test(p.name)) out.exchangeName++;
    else if (p.category === 'Bridge' && p.chains.length < 2) out.oneChainBridge++;
    else if (p.tvl_usd <= 0) out.noTvl++;
  }
  return out;
}

/** What one hour of the reader's time is valued at in the verdict arithmetic. */
export const TIME_USD_PER_HOUR = 20;

/** Fitted launch odds at or above which a plan can earn a GO verdict. */
export const VERDICT_GO_PROB = 0.5;

/** Fitted launch odds at or above which a plan can earn a SELECTIVE verdict. */
export const VERDICT_SELECTIVE_PROB = 0.35;

interface Scored {
  p: SnapshotProtocol;
  imp: Implied;
  plan: FarmPlan;
  prob: number;
  ev: number;
  fullCost: number;
  efficiency: number;
  verdict: Verdict;
}

function verdictSentence(s: Scored, medianEfficiency: number): string {
  const label = s.verdict === 'go' ? 'GO' : s.verdict === 'selective' ? 'SELECTIVE' : 'SKIP';
  return (
    ` Verdict: ${label} - ${Math.round(s.prob * 100)}% fitted launch odds x ${money(s.imp.value)} implied = ${money(s.ev)} probability-weighted value; ${money(s.efficiency)} per $1 of full cost (${money(s.plan.costUsd)} fees + ${s.plan.hours.toFixed(1)}h at $${TIME_USD_PER_HOUR}/h), board median ${money(medianEfficiency)}.`
  );
}

/** Score every pre-token protocol and build the ranked board plus page data. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const vm = fitAll(snapshot);
  const fit = vm.fit;
  const launch = fitLaunchModel(snapshot);
  const peerIndex = buildPeerIndex(snapshot);
  const watch = new Set(snapshot.watchlist);
  const subjects = snapshot.protocols.filter((p) => isRankable(p) && p.tvl_usd > 0);
  const scored: Scored[] = subjects
    .map((p) => {
      const imp = impliedFor(p, vm);
      const plan = farmPlan(p, snapshot);
      const prob = launch.predict(p);
      const fullCost = plan.costUsd + plan.hours * TIME_USD_PER_HOUR;
      const ev = prob * imp.value;
      return { p, imp, plan, prob, ev, fullCost, efficiency: fullCost > 0 ? ev / fullCost : 0, verdict: 'skip' as Verdict };
    })
    .sort((a, b) => b.imp.value - a.imp.value || (a.p.slug < b.p.slug ? -1 : 1));
  const chosen = scored.slice(0, BOARD_TARGET);
  for (const s of scored) {
    if (watch.has(s.p.slug) && !chosen.includes(s)) chosen.push(s);
  }
  chosen.sort((a, b) => b.imp.value - a.imp.value || (a.p.slug < b.p.slug ? -1 : 1));
  const effValues = chosen.map((s) => s.efficiency);
  const effMedian = quartile(effValues, 0.5);
  const effP25 = quartile(effValues, 0.25);
  const effP90 = quartile(effValues, 0.9);
  const verdictCounts = { go: 0, selective: 0, skip: 0 };
  for (const s of chosen) {
    s.verdict =
      s.prob >= VERDICT_GO_PROB && s.efficiency >= effMedian
        ? 'go'
        : (s.prob >= VERDICT_SELECTIVE_PROB && s.efficiency >= effP25) || s.efficiency >= effP90
          ? 'selective'
          : 'skip';
    verdictCounts[s.verdict]++;
    const steps = s.plan.steps;
    steps[steps.length - 1] = steps[steps.length - 1]! + verdictSentence(s, effMedian);
  }
  const board: BoardRow[] = [];
  const rows: RadarRow[] = [];
  chosen.forEach((s, i) => {
    const row: BoardRow = { slug: s.p.slug, name: s.p.name, rank: i + 1, implied_value_usd: s.imp.value, farm_steps: s.plan.steps };
    board.push(row);
    rows.push({
      ...row,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      age_days: ageDays(snapshot.as_of, s.p.listed_at),
      watchlist: watch.has(s.p.slug),
      implied_low_usd: s.imp.low,
      implied_high_usd: s.imp.high,
      multiple: Math.round(s.imp.multiple * 1000) / 1000,
      parts: {
        base: Math.round(Math.exp(s.imp.baseLog)),
        category: Math.round(Math.exp(s.imp.categoryOffset) * 1000) / 1000,
        growth: Math.round(Math.exp(s.imp.growthAdj) * 1000) / 1000,
        age: Math.round(Math.exp(s.imp.ageAdj) * 1000) / 1000,
        other: Math.round(Math.exp(s.imp.otherAdj) * 1000) / 1000,
      },
      launch_prob: Math.round(s.prob * 1000) / 1000,
      expected_value_usd: Math.round(s.ev),
      verdict: s.verdict,
      efficiency: Math.round(s.efficiency),
      odds: peerIndex(s.p),
      farm_cost_usd: s.plan.costUsd,
      farm_hours: s.plan.hours,
      farm_capital_usd: s.plan.capitalUsd,
      farm_weeks: s.plan.weeks,
    });
  });
  const live: LiveRow[] = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd!)
    .slice(0, 36)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd!, multiple: Math.round((p.mcap_usd! / p.tvl_usd) * 1000) / 1000 }));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    counts: {
      protocols: snapshot.protocols.length,
      preToken: snapshot.protocols.filter(recordsNoToken).length,
      eligible: subjects.length,
      pricedComps: fit.samples,
      unpricedListed: fit.unpricedListed,
      watchlist: snapshot.watchlist.length,
      boardRows: board.length,
    },
    excluded: exclusionCounts(snapshot),
    model: {
      samples: fit.samples,
      variant: fit.variant,
      featureCount: fit.featureCount,
      featureNames: fit.featureNames,
      lambda: fit.lambda,
      slope: Math.round(fit.slope * 1000) / 1000,
      intercept: Math.round(fit.intercept * 1000) / 1000,
      growthCoefPerPct: Math.round(fit.growthCoef * 10000) / 10000,
      ageCoefPerYear: Math.round(fit.ageCoef * 10000) / 10000,
      shrink: ADJUSTMENT_SHRINK,
      residQ25: Math.round(fit.residQ25 * 1000) / 1000,
      residQ75: Math.round(fit.residQ75 * 1000) / 1000,
      holdoutMedianFactor: Math.round(fit.holdoutMedianFactor * 100) / 100,
      validation: fit.validation.map((v) => ({
        variant: v.variant,
        walkForward1: Math.round(v.walkForward1 * 100) / 100,
        walkForward2: Math.round(v.walkForward2 * 100) / 100,
        blind: Math.round(v.blind * 100) / 100,
        threeFold: Math.round(v.threeFold * 100) / 100,
        mean: Math.round(v.mean * 100) / 100,
        chosen: v.chosen,
      })),
      cv: fit.cv.map((c) => ({ variant: c.variant, medianFactor: Math.round(c.medianFactor * 100) / 100, within2xPct: Math.round(c.within2xPct), within4xPct: Math.round(c.within4xPct) })),
      categories: fit.categories
        .filter((c) => c.samples >= 2)
        .map((c) => ({ category: c.category, samples: c.samples, multiple: Math.round(c.impliedMultiple * 1000) / 1000, slope: c.slope === null ? null : Math.round(c.slope * 1000) / 1000 })),
      launch: {
        samples: fit.launch.samples,
        launched: fit.launch.launched,
        baseRate: Math.round(fit.launch.baseRate * 1000) / 1000,
        auc: Math.round(fit.launch.auc * 1000) / 1000,
        brier: Math.round(fit.launch.brier * 1000) / 1000,
        features: fit.launch.features,
      },
      verdicts: {
        go: verdictCounts.go,
        selective: verdictCounts.selective,
        skip: verdictCounts.skip,
        medianEfficiency: Math.round(effMedian),
        p25Efficiency: Math.round(effP25),
        p90Efficiency: Math.round(effP90),
        timeUsdPerHour: TIME_USD_PER_HOUR,
      },
    },
    rows,
    live,
  };
  return { board, radar };
}

/** The gate's board rules, checked locally before anything is written. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  let prev = Number.POSITIVE_INFINITY;
  let firstValue: number | null = null;
  let allSame = true;
  for (let i = 0; i < board.length; i++) {
    const row = board[i]!;
    if (!slugs.has(row.slug)) return `row ${i + 1}: slug ${row.slug} is not in the snapshot`;
    if (seen.has(row.slug)) return `row ${i + 1}: slug ${row.slug} repeats`;
    seen.add(row.slug);
    if (row.rank !== i + 1) return `row ${i + 1}: rank is ${row.rank}`;
    if (!(row.implied_value_usd > 0) || row.implied_value_usd > 100_000_000_000_000) return `row ${i + 1}: implied value out of range`;
    if (row.implied_value_usd > prev) return `row ${i + 1}: implied value rises with rank`;
    prev = row.implied_value_usd;
    if (firstValue === null) firstValue = row.implied_value_usd;
    else if (row.implied_value_usd !== firstValue) allSame = false;
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `row ${i + 1}: ${row.farm_steps.length} farm steps`;
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `row ${i + 1}: a farm step is ${len} characters`;
    }
  }
  if (allSame && board.length > 1) return 'every implied value is the same';
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist protocol ${slug} is missing from the board`;
  }
  return null;
}

/** The dashboard's data as a script the page loads beside dashboard/. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}

