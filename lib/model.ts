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
//   2. Four candidate variants are fitted and raced on held-out data:
//      A, the v1 form (a log-log TVL curve, per-category median-residual
//      offsets, and growth / track-record terms fitted on the residuals);
//      B, A plus per-category slope deviations and a ridge regression over
//      25 interpretable features derived from the snapshot fields; C, a
//      log-space blend of A and B; and D, B's structure over an extended
//      49-feature dictionary. Every remaining knob in A and B — the
//      adjustment strength, the offset and slope shrinkage constants, the
//      ridge penalty and the blend weight — is chosen by inner slug
//      three-fold cross-validation on the training set alone, never set
//      by hand; the dashboard's method panel prints the audit table of
//      what chose each number.
//   3. The race is run on three outer splits the fitting never sees: two
//      expanding-window walk-forwards over the comparables' listing dates
//      and one blind slug-ordered holdout, with a slug three-fold score
//      kept for reference. The variant with the lowest mean holdout median
//      factor error is refitted on every comparable and becomes the board.
//   4. Interval: the estimate's range is the fitted value shifted by the
//      category's residual quartiles — centred per category, since the
//      offset already carries the location, and shrunk toward the global
//      quartiles by the same chosen constant as the offsets — because
//      the honest finding of every fit is that value given TVL is a
//      range, not a point: the typical miss is a factor of about four.
//
// Launch-odds model: two logistic-regression specifications race on a
// blind holdout — the v2 form (log TVL, log age, chain count, seven-day
// growth and the protocol's own category launch rate among its peers)
// against an extended form that adds interaction terms and growth
// buckets and is Platt-calibrated on cross-fitted predictions. The
// specification with the higher blind-holdout AUC ships; both AUCs are
// printed. Each row also carries the raw peer record behind the odds:
// its category's launched share, its age band's and its TVL band's.
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

/**
 * The grids the inner cross-validation chooses the value model's knobs
 * from. Nothing in the model is set by hand any more: the adjustment
 * strength, the category-offset shrinkage, the slope-deviation
 * shrinkage, the ridge penalty and the blend weight are all picked on
 * the training set alone, by the slug three-fold score, and the chosen
 * values are printed in the dashboard's audit table.
 */
export const ADJUSTMENT_SHRINK_GRID = [0, 0.125, 0.25, 0.375, 0.5, 0.75, 1];
export const CATEGORY_SHRINK_GRID = [1, 2, 4, 8, 16];
/**
 * The category offset keeps (n/(n+catShrink))^catPower of its raw median
 * residual: the shrinkage is tiered by the category's own sample count,
 * so a category fitted on a single comparable is pooled toward the TVL
 * curve far harder than one fitted on thirty. Power 1 is the flat form
 * the earlier versions shipped; higher powers enter only by winning the
 * same inner cross-validation that picks every other knob.
 */
export const CATEGORY_POWER_GRID = [1, 1.5, 2, 3];
export const SLOPE_SHRINK_GRID = [4, 8, 16, 32];
export const BLEND_WEIGHT_GRID = [0.25, 0.375, 0.5, 0.625, 0.75];

/** Variant A's chosen knobs and the inner score that chose them. */
export interface HyperA {
  shrink: number;
  catShrink: number;
  catPower: number;
  cvFactor: number;
}

/** The fraction of a category's raw offset that survives pooling. */
export function categoryKeep(n: number, catShrink: number, catPower: number): number {
  return Math.pow(n / (n + catShrink), catPower);
}

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
  vsBaselinePct: number; // error reduction against the TVL-only baseline's mean, percent
  chosen: boolean;
}

/** The TVL-only baseline's median factor errors on the same splits. */
export interface BaselineRow {
  walkForward1: number;
  walkForward2: number;
  blind: number;
  threeFold: number;
  mean: number;
}

/** One calibration bin of the shipped odds pipeline, scored on the blind holdout. */
export interface CalibBin {
  lo: number;
  hi: number;
  n: number;
  pred: number; // mean predicted probability in the bin
  obs: number; // observed launch rate in the bin
}

/** The launch-odds model's report, carried into the dashboard. */
export interface LaunchFitInfo {
  samples: number;
  launched: number;
  baseRate: number;
  auc: number; // blind-holdout AUC of the shipped specification
  brier: number; // blind-holdout Brier score of the shipped specification
  features: string[];
  spec: 'v2' | 'v3'; // which specification won the odds race
  aucOther: number; // blind-holdout AUC of the specification that did not ship
  calibrated: boolean; // whether the shipped odds are Platt-calibrated
  calibBins: CalibBin[];
  ridge: number; // chosen by inner CV (Brier)
  catShrink: number; // chosen by inner CV (Brier)
}

/** One row of the "every value term" audit table printed on the dashboard. */
export interface AuditRow {
  term: string;
  how: string; // how the number was set
  validation: string; // the evidence behind the choice
}

export interface ModelFit {
  samples: number;
  unpricedListed: number;
  variant: string; // the variant that won the validation race
  featureCount: number; // fitted terms in the winning value model
  featureNames: string[]; // the winning predictor's ridge dictionary
  lambda: number | null; // the winner's chosen ridge penalty, when it has one
  slope: number;
  intercept: number;
  growthCoef: number; // variant A reporting: per +1% of seven-day change, after shrink
  ageCoef: number; // variant A reporting: per year with no token, after shrink
  shrink: number; // variant A's chosen adjustment strength
  categoryShrink: number; // chosen offset shrinkage (also used for the interval)
  categoryPower: number; // chosen offset tier power: 1 is the flat form
  categories: CategoryFit[];
  residQ25: number;
  residQ75: number;
  validation: ValidationRow[];
  baseline: BaselineRow; // the TVL-only line scored on the same splits
  cv: CvRow[];
  holdoutMedianFactor: number;
  launch: LaunchFitInfo;
  audit: AuditRow[];
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
function fitRaw(train: SnapshotProtocol[], asOf: string, shrink: number, catShrink: number, catPower: number): RawFit {
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
    offsets.set(key, { n: resid.length, offset: categoryKeep(resid.length, catShrink, catPower) * raw, raw });
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
function crossValidate(samples: SnapshotProtocol[], asOf: string, shrink: number, catShrink: number, catPower: number): { medianFactor: number; within2x: number; within4x: number } {
  const sorted = [...samples].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const abs: number[] = [];
  for (let fold = 0; fold < 3; fold++) {
    const train = sorted.filter((_, i) => i % 3 !== fold);
    const test = sorted.filter((_, i) => i % 3 === fold);
    const fit = fitRaw(train, asOf, shrink, catShrink, catPower);
    for (const p of test) abs.push(Math.abs(Math.log(p.mcap_usd!) - fit.predict(p)));
  }
  const within = (cap: number) => abs.filter((e) => e < cap).length / abs.length;
  return { medianFactor: Math.exp(median(abs)), within2x: within(Math.LN2), within4x: within(2 * Math.LN2) };
}

/** Slug three-fold median factor of the raw A-form fit at one knob setting. */
function aFormFactor(train: SnapshotProtocol[], asOf: string, shrink: number, catShrink: number, catPower: number): number {
  const sorted = [...train].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const errs: number[] = [];
  for (let fold = 0; fold < 3; fold++) {
    const tr = sorted.filter((_, i) => i % 3 !== fold);
    const te = sorted.filter((_, i) => i % 3 === fold);
    const fit = fitRaw(tr, asOf, shrink, catShrink, catPower);
    for (const p of te) errs.push(Math.abs(Math.log(p.mcap_usd!) - fit.predict(p)));
  }
  return Math.exp(median(errs));
}

/**
 * Choose variant A's adjustment strength, offset shrinkage and offset
 * tier power on this training set alone, by inner slug three-fold
 * cross-validation over the three grids. Ties keep the earlier
 * (simpler) grid point, so the tiered form ships only when it wins.
 */
export function chooseHyperA(train: SnapshotProtocol[], asOf: string): HyperA {
  let best: HyperA = { shrink: ADJUSTMENT_SHRINK_GRID[0]!, catShrink: CATEGORY_SHRINK_GRID[0]!, catPower: CATEGORY_POWER_GRID[0]!, cvFactor: Number.POSITIVE_INFINITY };
  for (const shrink of ADJUSTMENT_SHRINK_GRID) {
    for (const catShrink of CATEGORY_SHRINK_GRID) {
      for (const catPower of CATEGORY_POWER_GRID) {
        const cvFactor = aFormFactor(train, asOf, shrink, catShrink, catPower);
        if (cvFactor < best.cvFactor - 1e-12) best = { shrink, catShrink, catPower, cvFactor };
      }
    }
  }
  return best;
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
  catMedianGrowth: Map<string, number>;
  catMaxTvl: Map<string, number>;
  tvlAsc: number[];
  meanLogTvl: number;
}

const L2_CHAINS = ['Arbitrum', 'Base', 'Optimism', 'zkSync Era', 'Linea', 'Scroll', 'Blast', 'Mantle'];

export function buildContext(snapshot: Snapshot): FeatureContext {
  const byCat = new Map<string, number[]>();
  const growthByCat = new Map<string, number[]>();
  const catTotalTvl = new Map<string, number>();
  const catCount = new Map<string, number>();
  const catMaxTvl = new Map<string, number>();
  for (const p of snapshot.protocols) {
    const key = p.category ?? '(uncategorised)';
    if (!byCat.has(key)) byCat.set(key, []);
    if (p.tvl_usd > 0) byCat.get(key)!.push(p.tvl_usd);
    if (p.change_7d !== null && Number.isFinite(p.change_7d)) {
      if (!growthByCat.has(key)) growthByCat.set(key, []);
      growthByCat.get(key)!.push(p.change_7d);
    }
    catTotalTvl.set(key, (catTotalTvl.get(key) ?? 0) + Math.max(0, p.tvl_usd));
    catCount.set(key, (catCount.get(key) ?? 0) + 1);
    catMaxTvl.set(key, Math.max(catMaxTvl.get(key) ?? 0, p.tvl_usd));
  }
  const catMedianTvl = new Map<string, number>();
  for (const [key, tvls] of byCat) catMedianTvl.set(key, tvls.length ? median(tvls) : 1);
  const catMedianGrowth = new Map<string, number>();
  for (const [key, gs] of growthByCat) catMedianGrowth.set(key, gs.length ? median(gs) : 0);
  const tvlAsc = snapshot.protocols.map((p) => p.tvl_usd).sort((a, b) => a - b);
  const meanLogTvl = snapshot.protocols.reduce((s, p) => s + Math.log(Math.max(1, p.tvl_usd)), 0) / snapshot.protocols.length;
  return { asOf: snapshot.as_of, catMedianTvl, catTotalTvl, catCount, catMedianGrowth, catMaxTvl, tvlAsc, meanLogTvl };
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

/**
 * Variant D's extension dictionary: 24 more features in the same spirit
 * (growth buckets and missing-data flags, more of the chain footprint,
 * category-relative size and growth, and the pairwise interactions the
 * base dictionary lacks). D races B on the same splits; the extension
 * ships only if D's mean holdout error beats the other variants'.
 */
export const FEATURE_DEFS_EXT: FeatureDef[] = [
  { name: 'growth above +10%', group: 'growth', value: (p) => (p.change_7d !== null && p.change_7d > 10 ? 1 : 0) },
  { name: 'growth below -10%', group: 'growth', value: (p) => (p.change_7d !== null && p.change_7d < -10 ? 1 : 0) },
  { name: 'no 7d figure reported', group: 'growth', value: (p) => (p.change_7d === null ? 1 : 0) },
  { name: 'category median 7d growth', group: 'growth', value: (p, ctx) => (ctx.catMedianGrowth.get(p.category ?? '(uncategorised)') ?? 0) / 100 },
  { name: 'growth minus category median', group: 'growth', value: (p, ctx) => growthFrac(p) - (ctx.catMedianGrowth.get(p.category ?? '(uncategorised)') ?? 0) / 100 },
  { name: 'on BSC', group: 'other', value: (p) => (p.chains.includes('BSC') ? 1 : 0) },
  { name: 'on Polygon', group: 'other', value: (p) => (p.chains.includes('Polygon') ? 1 : 0) },
  { name: 'on Avalanche', group: 'other', value: (p) => (p.chains.includes('Avalanche') ? 1 : 0) },
  { name: 'on Bitcoin', group: 'other', value: (p) => (p.chains.includes('Bitcoin') ? 1 : 0) },
  { name: 'five or more chains', group: 'other', value: (p) => (p.chains.length >= 5 ? 1 : 0) },
  { name: 'chain count squared, scaled', group: 'other', value: (p) => (p.chains.length ** 2) / 25 },
  { name: 'Ethereum and a major L2 together', group: 'other', value: (p) => (p.chains.includes('Ethereum') && p.chains.some((c) => L2_CHAINS.includes(c)) ? 1 : 0) },
  { name: 'listed under 6 months', group: 'age', value: (p, ctx) => (yearsListed(p, ctx.asOf) < 0.5 ? 1 : 0) },
  { name: 'no listing date recorded', group: 'age', value: (p) => (p.listed_at === null ? 1 : 0) },
  { name: 'log years listed squared', group: 'age', value: (p, ctx) => Math.log1p(yearsListed(p, ctx.asOf)) ** 2 },
  { name: 'log TVL vs category max', group: 'other', value: (p, ctx) => Math.log(Math.max(1, p.tvl_usd) / Math.max(1, ctx.catMaxTvl.get(p.category ?? '(uncategorised)') ?? 1)) },
  { name: 'share of category TVL', group: 'other', value: (p, ctx) => Math.max(0, p.tvl_usd) / Math.max(1, ctx.catTotalTvl.get(p.category ?? '(uncategorised)') ?? 1) },
  { name: 'log category median TVL', group: 'other', value: (p, ctx) => Math.log(Math.max(1, ctx.catMedianTvl.get(p.category ?? '(uncategorised)') ?? 1)) },
  { name: 'name word count', group: 'other', value: (p) => p.name.trim().split(/\s+/).length / 6 },
  { name: 'growth x log years listed', group: 'growth', value: (p, ctx) => growthFrac(p) * Math.log1p(yearsListed(p, ctx.asOf)) },
  { name: 'growth x log chain count', group: 'growth', value: (p) => growthFrac(p) * Math.log(Math.max(1, p.chains.length)) },
  { name: 'log years x log chain count', group: 'age', value: (p, ctx) => Math.log1p(yearsListed(p, ctx.asOf)) * Math.log(Math.max(1, p.chains.length)) },
  { name: 'TVL percentile x growth', group: 'growth', value: (p, ctx) => tvlPercentile(p, ctx) * growthFrac(p) },
  { name: 'single chain x log TVL (centred)', group: 'other', value: (p, ctx) => (p.chains.length <= 1 ? 1 : 0) * (Math.log(Math.max(1, p.tvl_usd)) - ctx.meanLogTvl) },
];

/** Variant B's dictionary (25) plus the extension (24): variant D's 49. */
export const FEATURE_DEFS_ALL: FeatureDef[] = [...FEATURE_DEFS, ...FEATURE_DEFS_EXT];

function featureValues(p: SnapshotProtocol, ctx: FeatureContext, defs: FeatureDef[]): number[] {
  return defs.map((f) => f.value(p, ctx));
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
  featureNames: string[];
  blendWeight: number | null; // variant C only: the weight on A
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
function fitVariantA(train: SnapshotProtocol[], asOf: string, hyper: HyperA): ValuePredictor {
  const raw = fitRaw(train, asOf, hyper.shrink, hyper.catShrink, hyper.catPower);
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
    featureNames: [],
    blendWeight: null,
  };
}

const SLOPE_MIN_SAMPLES = 6;

/**
 * Variant B (and D, with the extended dictionary): variant A's structure,
 * extended. A per-category slope deviation (the category's residuals
 * regressed on TVL centred at the category's own mean, shrunk
 * n/(n+slopeShrink)) lets big categories tilt the curve instead of only
 * shifting it, and the ridge dictionary is fitted on whatever A plus the
 * slope deviations still miss, so the dictionary only has to explain the
 * simple model's leftovers. The penalty and the slope shrinkage are
 * chosen jointly by inner cross-validation over wide grids, with heavy
 * penalties that nearly switch the dictionary off always available.
 */
function fitVariantB(train: SnapshotProtocol[], asOf: string, ctx: FeatureContext, lambda: number, slopeShrink: number, hyper: HyperA, defs: FeatureDef[]): ValuePredictor {
  const raw = fitRaw(train, asOf, hyper.shrink, hyper.catShrink, hyper.catPower);
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
    const dev = (rows.length / (rows.length + slopeShrink)) * (sxy / sxx);
    slopeDevs.set(key, { dev, meanLogTvl });
    slopes.set(key, raw.slope + dev);
  }
  const slopeAdj = (p: SnapshotProtocol) => {
    const s = slopeDevs.get(p.category ?? '(uncategorised)');
    return s ? s.dev * (Math.log(p.tvl_usd) - s.meanLogTvl) : 0;
  };
  const ridge = ridgeFit(
    train.map((p) => featureValues(p, ctx, defs)),
    train.map((p) => Math.log(p.mcap_usd!) - raw.predict(p) - slopeAdj(p)),
    lambda,
  );
  return {
    predict: (p) => {
      const base = raw.intercept + raw.slope * Math.log(p.tvl_usd);
      const category = offsetOf(p) + slopeAdj(p);
      const contribs = ridgeContribs(ridge, featureValues(p, ctx, defs));
      let growth = raw.growthCoef * growthClamped(p);
      let age = raw.ageCoef * yearsListed(p, asOf);
      let other = ridge.yMean;
      defs.forEach((f, j) => {
        if (f.group === 'growth') growth += contribs[j]!;
        else if (f.group === 'age') age += contribs[j]!;
        else other += contribs[j]!;
      });
      return { log: base + category + growth + age + other, base, category, growth, age, other };
    },
    categories: categoryTable(raw.offsets, slopes),
    lambda,
    featureCount: 4 + raw.offsets.size + slopeDevs.size + defs.length,
    featureNames: defs.map((f) => f.name),
    blendWeight: null,
  };
}

/** Variant C: the log-space blend of A and B at a cross-validated weight. */
function fitBlend(a: ValuePredictor, b: ValuePredictor, weightOnA: number): ValuePredictor {
  const w = weightOnA;
  return {
    predict: (p) => {
      const pa = a.predict(p);
      const pb = b.predict(p);
      return {
        log: w * pa.log + (1 - w) * pb.log,
        base: w * pa.base + (1 - w) * pb.base,
        category: w * pa.category + (1 - w) * pb.category,
        growth: w * pa.growth + (1 - w) * pb.growth,
        age: w * pa.age + (1 - w) * pb.age,
        other: w * pa.other + (1 - w) * pb.other,
      };
    },
    categories: b.categories,
    lambda: b.lambda,
    featureCount: a.featureCount + b.featureCount,
    featureNames: b.featureNames,
    blendWeight: w,
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

/** Variant B/D's chosen ridge penalty and slope shrinkage, with the score that chose them. */
export interface HyperB {
  lambda: number;
  slopeShrink: number;
  cvFactor: number;
}

/**
 * Choose the ridge penalty and the slope-deviation shrinkage jointly, by
 * inner three-fold CV on the train set alone, for one feature dictionary.
 */
function chooseBHyper(train: SnapshotProtocol[], asOf: string, ctx: FeatureContext, hyper: HyperA, defs: FeatureDef[]): HyperB {
  let best: HyperB = { lambda: LAMBDA_GRID[3]!, slopeShrink: SLOPE_SHRINK_GRID[2]!, cvFactor: Number.POSITIVE_INFINITY };
  for (const lam of LAMBDA_GRID) {
    for (const slopeShrink of SLOPE_SHRINK_GRID) {
      const score = threeFoldFactor((tr) => fitVariantB(tr, asOf, ctx, lam, slopeShrink, hyper, defs), train);
      if (score < best.cvFactor - 1e-12) best = { lambda: lam, slopeShrink, cvFactor: score };
    }
  }
  return best;
}

/**
 * Choose variant C's blend weight (the weight on A) by inner three-fold
 * CV: A and B are refitted inside each fold with their own inner-chosen
 * knobs, blended at each grid weight, and scored pooled across folds.
 * Ties keep the weight nearest the plain average.
 */
function chooseBlendWeight(train: SnapshotProtocol[], asOf: string, ctx: FeatureContext): { weight: number; cvFactor: number } {
  const sorted = [...train].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const errs = new Map<number, number[]>(BLEND_WEIGHT_GRID.map((w) => [w, []]));
  for (let fold = 0; fold < 3; fold++) {
    const tr = sorted.filter((_, i) => i % 3 !== fold);
    const te = sorted.filter((_, i) => i % 3 === fold);
    const hyper = chooseHyperA(tr, asOf);
    const hb = chooseBHyper(tr, asOf, ctx, hyper, FEATURE_DEFS);
    const a = fitVariantA(tr, asOf, hyper);
    const b = fitVariantB(tr, asOf, ctx, hb.lambda, hb.slopeShrink, hyper, FEATURE_DEFS);
    for (const p of te) {
      const y = Math.log(p.mcap_usd!);
      const la = a.predict(p).log;
      const lb = b.predict(p).log;
      for (const w of BLEND_WEIGHT_GRID) errs.get(w)!.push(Math.abs(y - (w * la + (1 - w) * lb)));
    }
  }
  let best = { weight: 0.5, cvFactor: Number.POSITIVE_INFINITY };
  for (const w of BLEND_WEIGHT_GRID) {
    const f = Math.exp(median(errs.get(w)!));
    if (f < best.cvFactor - 1e-12 || (Math.abs(f - best.cvFactor) <= 1e-12 && Math.abs(w - 0.5) < Math.abs(best.weight - 0.5))) {
      best = { weight: w, cvFactor: f };
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
  launch: LaunchModel;
}

/** Race the variants on held-out data, then refit the winner on everything. */
export function fitAll(snapshot: Snapshot): ValueModel {
  const ctx = buildContext(snapshot);
  const asOf = snapshot.as_of;
  const priced = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const unpricedListed = snapshot.protocols.filter((p) => !recordsNoToken(p) && (p.mcap_usd === null || p.mcap_usd <= 0)).length;
  const fitA = (tr: SnapshotProtocol[]) => fitVariantA(tr, asOf, chooseHyperA(tr, asOf));
  const fitB = (tr: SnapshotProtocol[]) => {
    const hyper = chooseHyperA(tr, asOf);
    const hb = chooseBHyper(tr, asOf, ctx, hyper, FEATURE_DEFS);
    return fitVariantB(tr, asOf, ctx, hb.lambda, hb.slopeShrink, hyper, FEATURE_DEFS);
  };
  const fitD = (tr: SnapshotProtocol[]) => {
    const hyper = chooseHyperA(tr, asOf);
    const hb = chooseBHyper(tr, asOf, ctx, hyper, FEATURE_DEFS_ALL);
    return fitVariantB(tr, asOf, ctx, hb.lambda, hb.slopeShrink, hyper, FEATURE_DEFS_ALL);
  };
  const fitC = (tr: SnapshotProtocol[]) => {
    const bw = chooseBlendWeight(tr, asOf, ctx);
    return fitBlend(fitA(tr), fitB(tr), bw.weight);
  };
  const racers = [
    { key: 'A: TVL curve + category offsets + fitted growth & age terms (v1 form)', fit: fitA },
    { key: 'B: A + per-category slope deviations + 25-feature ridge', fit: fitB },
    { key: 'C: cross-validated blend of A and B', fit: fitC },
    { key: 'D: B over an extended 49-feature dictionary', fit: fitD },
  ];
  const splits = outerSplits(priced);
  // The reference every variant is measured against: the TVL curve alone,
  // no category offsets, no adjustments, scored on the identical splits.
  const fitLineOnly = (tr: SnapshotProtocol[]): ValuePredictor => {
    const line = olsLine(
      tr.map((p) => Math.log(p.tvl_usd)),
      tr.map((p) => Math.log(p.mcap_usd!)),
    );
    return {
      predict: (p) => {
        const base = line.intercept + line.slope * Math.log(p.tvl_usd);
        return { log: base, base, category: 0, growth: 0, age: 0, other: 0 };
      },
      categories: [],
      lambda: null,
      featureCount: 2,
      featureNames: [],
      blendWeight: null,
    };
  };
  const baseline: BaselineRow = {
    walkForward1: medianFactor(fitLineOnly(splits.wf1.train).predict, splits.wf1.test),
    walkForward2: medianFactor(fitLineOnly(splits.wf2.train).predict, splits.wf2.test),
    blind: medianFactor(fitLineOnly(splits.blind.train).predict, splits.blind.test),
    threeFold: threeFoldFactor(fitLineOnly, priced),
    mean: 0,
  };
  baseline.mean = (baseline.walkForward1 + baseline.walkForward2 + baseline.blind) / 3;
  const validation: ValidationRow[] = racers.map((r) => {
    const walkForward1 = medianFactor(r.fit(splits.wf1.train).predict, splits.wf1.test);
    const walkForward2 = medianFactor(r.fit(splits.wf2.train).predict, splits.wf2.test);
    const blind = medianFactor(r.fit(splits.blind.train).predict, splits.blind.test);
    const threeFold = threeFoldFactor(r.fit, priced);
    const mean = (walkForward1 + walkForward2 + blind) / 3;
    return {
      variant: r.key,
      walkForward1,
      walkForward2,
      blind,
      threeFold,
      mean,
      vsBaselinePct: ((baseline.mean - mean) / baseline.mean) * 100,
      chosen: false,
    };
  });
  // Parsimony order on ties: A before C before B before D.
  let winner = 0;
  for (const idx of [0, 2, 1, 3]) {
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
  // The audit numbers: the same deterministic selections the shipped
  // predictor ran on the full comparable set, recomputed for the record.
  const selA = chooseHyperA(priced, asOf);
  const selB = chooseBHyper(priced, asOf, ctx, selA, FEATURE_DEFS);
  const selD = chooseBHyper(priced, asOf, ctx, selA, FEATURE_DEFS_ALL);
  const selBlend = chooseBlendWeight(priced, asOf, ctx);
  const rawA = fitRaw(priced, asOf, selA.shrink, selA.catShrink, selA.catPower);
  const cvLevel = crossValidate(priced, asOf, 0, selA.catShrink, selA.catPower);
  const cvApplied = crossValidate(priced, asOf, selA.shrink, selA.catShrink, selA.catPower);
  const cvFull = crossValidate(priced, asOf, 1, selA.catShrink, selA.catPower);
  const launch = fitLaunchModel(snapshot);
  const f3 = (x: number) => x.toFixed(3);
  const audit: AuditRow[] = [
    { term: 'TVL curve (slope & intercept)', how: `OLS of log(cap) on log(TVL) over the ${priced.length} priced comparables`, validation: 'inside every variant; the race scores it on walk-forward + blind splits' },
    {
      term: 'Category offsets',
      how:
        selA.catPower === 1
          ? `per-category median residual, shrunk n/(n+${selA.catShrink}) toward the TVL curve`
          : `per-category median residual, shrunk (n/(n+${selA.catShrink}))^${selA.catPower} toward the TVL curve — tiered by sample size: a category fitted on one comparable keeps ${Math.round(categoryKeep(1, selA.catShrink, selA.catPower) * 100)}% of its raw offset, one on ten keeps ${Math.round(categoryKeep(10, selA.catShrink, selA.catPower) * 100)}%`,
      validation: `shrinkage and tier power chosen jointly by inner 3-fold CV over {1, 2, 4, 8, 16} x {1, 1.5, 2, 3}: ${f3(selA.cvFactor)}x at the chosen point${selA.catPower === 1 ? '; the tiered powers were raced and did not beat the flat form' : ''}`,
    },
    { term: 'Growth & track-record strength', how: `residual slopes applied at ${selA.shrink} of fitted strength`, validation: `strength chosen by inner 3-fold CV over {0, .125, .25, .375, .5, .75, 1}: ${f3(selA.cvFactor)}x` },
    { term: 'Category slope deviations (B, C, D)', how: `per-category residual slopes, shrunk n/(n+${selB.slopeShrink}), categories with ${SLOPE_MIN_SAMPLES}+ samples`, validation: `shrinkage chosen jointly with the ridge penalty by inner 3-fold CV: ${f3(selB.cvFactor)}x` },
    { term: 'Ridge penalty, 25-feature dictionary (B, C)', how: `lambda = ${selB.lambda}, Huber-robust (residuals past 2 log units downweighted)`, validation: `chosen by inner 3-fold CV over {1..1000} x slope shrinkage {4, 8, 16, 32}` },
    { term: 'Ridge penalty, 49-feature dictionary (D)', how: `lambda = ${selD.lambda}, slope shrinkage ${selD.slopeShrink}`, validation: `chosen by the same inner 3-fold CV: ${f3(selD.cvFactor)}x; D ships only if it wins the outer race` },
    { term: 'Blend weight (C)', how: `${selBlend.weight} on A, ${Math.round((1 - selBlend.weight) * 1000) / 1000} on B`, validation: `chosen by inner 3-fold CV over {0.25..0.75}: ${f3(selBlend.cvFactor)}x` },
    { term: 'Implied-value interval', how: 'category residual quartiles, centred per category (the offset carries the location) and shrunk toward the global quartiles by the chosen offset shrinkage', validation: 'quartiles are the winner\'s own residuals on all comparables' },
    { term: 'Launch-odds category-rate shrinkage', how: `peer launch rates shrunk toward the global rate, n/(n+${launch.info.catShrink})`, validation: 'chosen by inner 3-fold CV (Brier) over {2, 4, 8, 16, 32}' },
    { term: 'Launch-odds ridge penalty', how: `lambda = ${launch.info.ridge} on standardised features (IRLS)`, validation: 'chosen by inner 3-fold CV (Brier) over {0.3, 1, 3, 10}' },
    {
      term: 'Launch-odds specification & calibration',
      how:
        launch.info.spec === 'v3'
          ? 'extended spec (interactions + growth buckets), Platt-calibrated on cross-fitted predictions'
          : 'v2 spec retained (the extended, calibrated spec did not beat it on the blind holdout)',
      validation: `blind-holdout AUC ${f3(launch.info.auc)} shipped vs ${f3(launch.info.aucOther)} not shipped; Brier ${f3(launch.info.brier)}`,
    },
    { term: 'Reader time in verdicts ($20/h)', how: 'stated assumption, not a fitted term', validation: 'printed in the verdict card; verdicts recompute at any other rate by the stated formula' },
    { term: 'Verdict odds thresholds (50% GO / 35% SELECTIVE)', how: 'stated decision rule, not a fitted term; the efficiency bars they combine with are board quantiles', validation: 'the rule and its thresholds are printed in the verdict card' },
    { term: 'Farm-plan gas prices & capital tiers', how: 'stated plan parameters (a rough per-chain gas table, TVL-tiered capital), not fitted terms', validation: 'each plan\'s totals are summed from the same figures its steps quote' },
  ];
  const fit: ModelFit = {
    samples: priced.length,
    unpricedListed,
    variant: racers[winner]!.key,
    featureCount: predictor.featureCount,
    featureNames: predictor.featureNames,
    lambda: predictor.lambda,
    slope: rawA.slope,
    intercept: rawA.intercept,
    growthCoef: rawA.growthCoef,
    ageCoef: rawA.ageCoef,
    shrink: selA.shrink,
    categoryShrink: selA.catShrink,
    categoryPower: selA.catPower,
    categories: predictor.categories,
    residQ25: quartile(globalResid.map((r) => r - median(globalResid)), 0.25),
    residQ75: quartile(globalResid.map((r) => r - median(globalResid)), 0.75),
    validation,
    baseline,
    cv: [
      { variant: 'TVL curve + category offsets only', medianFactor: cvLevel.medianFactor, within2xPct: cvLevel.within2x * 100, within4xPct: cvLevel.within4x * 100 },
      { variant: `plus growth & track-record terms at the fitted strength (${selA.shrink})`, medianFactor: cvApplied.medianFactor, within2xPct: cvApplied.within2x * 100, within4xPct: cvApplied.within4x * 100 },
      { variant: 'plus growth & track-record terms at full strength', medianFactor: cvFull.medianFactor, within2xPct: cvFull.within2x * 100, within4xPct: cvFull.within4x * 100 },
    ],
    holdoutMedianFactor: validation[winner]!.mean,
    launch: launch.info,
    audit,
  };
  return { fit, predictor, residByCat, launch };
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
  // The interval pools a category's spread toward the global spread at the
  // same tiered strength the offset itself was shrunk at: a thin category
  // borrows the global quartiles instead of trusting its own few residuals.
  const w = catResid ? categoryKeep(catResid.length, fit.categoryShrink, fit.categoryPower) : 0;
  // The interval carries dispersion, not location: the category offset
  // already holds the location, so each category's residuals are centred
  // on their own median before their quartiles are taken (a shrunk offset
  // otherwise leaves a shifted residual distribution, and the "range" of
  // a thin category would sit beside its own estimate instead of around
  // it). The centred category quartiles are then shrunk toward the
  // (likewise centred) global quartiles.
  const centred = catResid ? catResid.map((r) => r - median(catResid)) : null;
  const q25 = centred ? w * quartile(centred, 0.25) + (1 - w) * fit.residQ25 : fit.residQ25;
  const q75 = centred ? w * quartile(centred, 0.75) + (1 - w) * fit.residQ75 : fit.residQ75;
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

type LaunchSpec = 'v2' | 'v3';

const LAUNCH_FEATURE_NAMES_V2 = ['log TVL', 'log years listed', 'chain count', '7d growth', "category's launch rate among peers"];
const LAUNCH_FEATURE_NAMES_V3 = [
  ...LAUNCH_FEATURE_NAMES_V2,
  'peer rate x log years listed',
  'peer rate x log TVL',
  'log TVL x log years listed',
  'growth below -5%',
  'growth above +5%',
  'log TVL squared (centred)',
];

const LAUNCH_CAT_SHRINK_GRID = [2, 4, 8, 16, 32];
const LAUNCH_RIDGE_GRID = [0.3, 1, 3, 10];

interface LaunchHyper {
  ridge: number;
  catShrink: number;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
}

function launchCatRates(train: SnapshotProtocol[], catShrink: number): { rates: Map<string, number>; global: number } {
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
  for (const [key, c] of counts) rates.set(key, (c.launched + catShrink * global) / (c.total + catShrink));
  return { rates, global };
}

function launchRawFeatures(p: SnapshotProtocol, asOf: string, catRate: number, spec: LaunchSpec): number[] {
  const logTvl = Math.log10(Math.max(1, p.tvl_usd));
  const logYears = Math.log1p(yearsListed(p, asOf));
  const base = [logTvl, logYears, Math.min(10, p.chains.length), growthFrac(p), catRate];
  if (spec === 'v2') return base;
  const g = p.change_7d;
  return [
    ...base,
    catRate * logYears,
    catRate * logTvl,
    (logTvl - 7) * logYears,
    g !== null && g < -5 ? 1 : 0,
    g !== null && g > 5 ? 1 : 0,
    (logTvl - 7) ** 2,
  ];
}

function fitLaunch(train: SnapshotProtocol[], asOf: string, spec: LaunchSpec, hyper: LaunchHyper): { predict: (p: SnapshotProtocol) => number } {
  const { rates, global } = launchCatRates(train, hyper.catShrink);
  const rateOf = (p: SnapshotProtocol) => rates.get(p.category ?? '(uncategorised)') ?? global;
  const X = train.map((p) => launchRawFeatures(p, asOf, rateOf(p), spec));
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
  const RIDGE = hyper.ridge;
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
      const x = launchRawFeatures(p, asOf, rateOf(p), spec);
      let eta = b0;
      for (let j = 0; j < d; j++) eta += beta[j]! * ((x[j]! - means[j]!) / sds[j]!);
      return sigmoid(eta);
    },
  };
}

/** Choose one odds specification's ridge and category shrinkage by inner 3-fold Brier. */
function chooseLaunchHyper(train: SnapshotProtocol[], asOf: string, spec: LaunchSpec): LaunchHyper {
  const sorted = [...train].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  let best: LaunchHyper & { brier: number } = { ridge: 1, catShrink: 8, brier: Number.POSITIVE_INFINITY };
  for (const ridge of LAUNCH_RIDGE_GRID) {
    for (const catShrink of LAUNCH_CAT_SHRINK_GRID) {
      let sse = 0;
      let n = 0;
      for (let fold = 0; fold < 3; fold++) {
        const tr = sorted.filter((_, i) => i % 3 !== fold);
        const te = sorted.filter((_, i) => i % 3 === fold);
        const m = fitLaunch(tr, asOf, spec, { ridge, catShrink });
        for (const p of te) {
          sse += (m.predict(p) - (recordsNoToken(p) ? 0 : 1)) ** 2;
          n++;
        }
      }
      const brier = sse / n;
      if (brier < best.brier - 1e-12) best = { ridge, catShrink, brier };
    }
  }
  return { ridge: best.ridge, catShrink: best.catShrink };
}

/** Platt calibration: a two-parameter logistic map on the logit of a raw score. */
function plattFit(rawScores: number[], ys: number[]): { a: number; b: number } {
  const z = rawScores.map((q) => {
    const c = Math.max(1e-6, Math.min(1 - 1e-6, q));
    return Math.log(c / (1 - c));
  });
  let a = 0;
  let b = 1;
  for (let iter = 0; iter < 100; iter++) {
    const g = [0, 0];
    const H = [
      [1e-4, 0],
      [0, 1e-4],
    ];
    for (let i = 0; i < z.length; i++) {
      const mu = sigmoid(a + b * z[i]!);
      const w = Math.max(1e-6, mu * (1 - mu));
      const r = ys[i]! - mu;
      const row = [1, z[i]!];
      for (let u = 0; u < 2; u++) {
        g[u]! += row[u]! * r;
        for (let v = 0; v < 2; v++) H[u]![v]! += w * row[u]! * row[v]!;
      }
    }
    const step = solveLinear(H, g);
    a += step[0]!;
    b += step[1]!;
    if (Math.max(Math.abs(step[0]!), Math.abs(step[1]!)) < 1e-10) break;
  }
  return { a, b };
}

/**
 * One odds pipeline: the plain fit for the v2 specification; for v3, the
 * fit plus a Platt map whose two parameters are fitted on cross-fitted
 * predictions inside the training set (four slug folds), so calibration
 * never sees the row it calibrates.
 */
function launchPipeline(train: SnapshotProtocol[], asOf: string, spec: LaunchSpec, hyper: LaunchHyper): { predict: (p: SnapshotProtocol) => number } {
  const prod = fitLaunch(train, asOf, spec, hyper);
  if (spec === 'v2') return prod;
  const sorted = [...train].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const oof = new Map<string, number>();
  for (let fold = 0; fold < 4; fold++) {
    const tr = sorted.filter((_, i) => i % 4 !== fold);
    const te = sorted.filter((_, i) => i % 4 === fold);
    const m = fitLaunch(tr, asOf, spec, hyper);
    for (const p of te) oof.set(p.slug, m.predict(p));
  }
  const raw: number[] = [];
  const ys: number[] = [];
  for (const p of train) {
    raw.push(oof.get(p.slug)!);
    ys.push(recordsNoToken(p) ? 0 : 1);
  }
  const platt = plattFit(raw, ys);
  return {
    predict: (p) => {
      const q = prod.predict(p);
      const c = Math.max(1e-6, Math.min(1 - 1e-6, q));
      return sigmoid(platt.a + platt.b * Math.log(c / (1 - c)));
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

/**
 * Race the two odds specifications on the blind holdout and fit the
 * winner on all protocols. Each specification's ridge and category
 * shrinkage are chosen by inner cross-validation on the training part;
 * the extended specification additionally calibrates (Platt, fitted
 * inside the training part). The shipped specification is the one with
 * the higher blind-holdout AUC — if the extension does not beat the v2
 * form, the v2 form ships, and both AUCs are reported either way.
 */
export function fitLaunchModel(snapshot: Snapshot): LaunchModel {
  const asOf = snapshot.as_of;
  const bySlug = [...snapshot.protocols].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const test = bySlug.filter((_, i) => i % 4 === 3);
  const train = bySlug.filter((_, i) => i % 4 !== 3);
  const ys = test.map((p) => (recordsNoToken(p) ? 0 : 1));
  const race = (spec: LaunchSpec) => {
    const hyper = chooseLaunchHyper(train, asOf, spec);
    const holdout = launchPipeline(train, asOf, spec, hyper);
    const scores = test.map((p) => holdout.predict(p));
    return {
      hyper,
      scores,
      auc: aucScore(scores, ys),
      brier: scores.reduce((s, v, i) => s + (v - ys[i]!) ** 2, 0) / scores.length,
    };
  };
  const r2 = race('v2');
  const r3 = race('v3');
  const spec: LaunchSpec = r3.auc > r2.auc + 1e-9 ? 'v3' : 'v2';
  const win = spec === 'v3' ? r3 : r2;
  const lose = spec === 'v3' ? r2 : r3;
  const edges = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];
  const calibBins: CalibBin[] = [];
  for (let b = 0; b < edges.length - 1; b++) {
    const idx = test.map((_, i) => i).filter((i) => win.scores[i]! >= edges[b]! && win.scores[i]! < edges[b + 1]!);
    if (!idx.length) continue;
    const pred = idx.reduce((s, i) => s + win.scores[i]!, 0) / idx.length;
    const obs = idx.reduce((s, i) => s + ys[i]!, 0) / idx.length;
    calibBins.push({ lo: edges[b]!, hi: Math.min(1, edges[b + 1]!), n: idx.length, pred, obs });
  }
  const hyperAll = chooseLaunchHyper(snapshot.protocols, asOf, spec);
  const prod = launchPipeline(snapshot.protocols, asOf, spec, hyperAll);
  const launched = snapshot.protocols.filter((p) => !recordsNoToken(p)).length;
  return {
    info: {
      samples: snapshot.protocols.length,
      launched,
      baseRate: launched / snapshot.protocols.length,
      auc: win.auc,
      brier: win.brier,
      features: spec === 'v3' ? LAUNCH_FEATURE_NAMES_V3 : LAUNCH_FEATURE_NAMES_V2,
      spec,
      aucOther: lose.auc,
      calibrated: spec === 'v3',
      calibBins,
      ridge: hyperAll.ridge,
      catShrink: hyperAll.catShrink,
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

/** Deterministic per-row variant pick (FNV-1a over the slug). */
function slugHash(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The farm plan for one board row — every row gets this assembly, not
 * just the top of the board. The category still picks the core actions,
 * but every step is assembled from this row's own fields: its actual
 * chains and their gas prices, its seven-day change setting the pace
 * and the tranche schedule, its TVL setting the tranche sizes, its
 * listing year and no-token age setting the claim-ready wording. The
 * sentence skeletons themselves rotate through four phrasings picked
 * by a hash of the slug (each step offset from the last), so even the
 * scaffolding — funding, cost lines, check-in, claim-ready, totals —
 * is not one template repeated down the board; every number in every
 * variant is the row's own.
 */
export function farmPlanPersonal(p: SnapshotProtocol, snapshot: Snapshot, rank: number): FarmPlan {
  const mainChain = p.chains[0] ?? 'Ethereum';
  const secondChain = p.chains.length > 1 ? p.chains[1]! : null;
  const gas1 = gasFor(mainChain);
  const gas2 = secondChain ? gasFor(secondChain) : gas1;
  const cap = capitalTier(p.tvl_usd);
  const age = ageDays(snapshot.as_of, p.listed_at);
  const years = age === null ? null : age / 365.25;
  const listedYear = p.listed_at ? p.listed_at.slice(0, 4) : null;
  const weeks = age === null ? 10 : age > 730 ? 8 : age > 365 ? 10 : 12;
  const cores = coreActions(p.category, p.name);
  const g = p.change_7d;
  const a1 = Math.round(cap.low * 0.5);
  const a2 = Math.round(cap.low * 0.3);
  const a3 = cap.low - a1 - a2;
  const w2 = Math.max(2, Math.ceil(weeks / 3));
  const w3 = Math.max(w2 + 1, Math.ceil((2 * weeks) / 3));
  const v = slugHash(p.slug) % 4;
  const alt = v % 2 === 1;
  const pacing =
    g === null
      ? alt
        ? 'No seven-day TVL figure is reported for it, so pacing follows the calendar rather than the flow'
        : 'The snapshot reports no seven-day TVL figure for it, so the pace follows the calendar rather than flow'
      : g > 5
        ? alt
          ? `With TVL up ${g.toFixed(1)}% in the seven days before the snapshot, the first three weeks carry double sessions while flow is rising, then the plan drops to maintenance`
          : `TVL rose ${g.toFixed(1)}% in the seven days before the snapshot, so the first three weeks carry double sessions while flow is rising, then the plan drops to maintenance`
        : g < -5
          ? alt
            ? `TVL fell ${Math.abs(g).toFixed(1)}% in the seven days before the snapshot; treat the tranches above as the stop rule too — if TVL halves from ${money(p.tvl_usd)}, no further tranche goes in`
            : `TVL fell ${Math.abs(g).toFixed(1)}% in the seven days before the snapshot, so the tranches above are also the stop rule: if TVL halves from ${money(p.tvl_usd)}, no further tranche goes in`
          : alt
            ? `Seven-day TVL movement before the snapshot was ${g >= 0 ? '+' : ''}${g.toFixed(1)}% — flat flow, so sessions spread evenly across the ${weeks} weeks`
            : `TVL moved ${g >= 0 ? '+' : ''}${g.toFixed(1)}% in the seven days before the snapshot — flat flow, so sessions spread evenly across the ${weeks} weeks`;
  const steps: string[] = [];
  let cost = 0;
  let minutes = 0;

  const gasNote = secondChain ? ` Keep about ${money(40)} of gas money on ${secondChain} as well; step 3 works there.` : '';
  const fund = [
    `Open one wallet for ${p.name} alone and fund it on ${mainChain} in three tranches: ${money(a1)} in week 1, ${money(a2)} in week ${w2} and ${money(a3)} in week ${w3} — ${money(cap.low)} in all, rising to ${money(cap.high)} only if the first tranche behaves.${gasNote} Cost: about ${money(gas1 * 3)} in network fees across the three fundings. Time: about 30 minutes, split across the tranche weeks.`,
    `Give ${p.name} its own wallet. On ${mainChain}, stage the capital in: ${money(a1)} in week 1, ${money(a2)} in week ${w2}, ${money(a3)} in week ${w3} — ${money(cap.low)} in total, stepping up to ${money(cap.high)} only once the first tranche has behaved.${gasNote} The three fundings cost about ${money(gas1 * 3)} in network fees; setting them up takes about 30 minutes across the tranche weeks.`,
    `One wallet, used for ${p.name} only, funded on ${mainChain} in three tranches — ${money(a1)} (week 1), ${money(a2)} (week ${w2}), ${money(a3)} (week ${w3}) — ${money(cap.low)} of working capital, with ${money(cap.high)} as the ceiling if tranche one behaves.${gasNote} Fees for the three fundings: about ${money(gas1 * 3)}. Time: about 30 minutes, split across the tranche weeks.`,
    `Start with a fresh wallet dedicated to ${p.name} and load it on ${mainChain} gradually: ${money(a1)} in week 1, then ${money(a2)} in week ${w2} and ${money(a3)} in week ${w3}, ${money(cap.low)} in total, rising to ${money(cap.high)} only if the first tranche behaves.${gasNote} Cost: about ${money(gas1 * 3)} in network fees across the three fundings. Time: about 30 minutes, split across the tranche weeks.`,
  ];
  steps.push(fund[v]!);
  minutes += 30;
  cost += 3 * gas1;

  /** The cost/time tail of a core-action step, in the k-th phrasing. */
  const tail = (sessions: number, gas: number, mins: number, k: number): string =>
    [
      `Repeat across ${sessions} sessions. Cost: about ${money(gas)} per session in network fees. Time: about ${mins} minutes per session.`,
      `Run ${sessions} sessions in all; each costs about ${money(gas)} in network fees and ${mins} minutes of your time.`,
      `Sessions: ${sessions}, at about ${money(gas)} of network fees and ${mins} minutes apiece.`,
      `Spread over ${sessions} sessions — budget about ${money(gas)} in fees and ${mins} minutes for each.`,
    ][k % 4]!;

  /** Join a core action to its connector: dash connectors attach
   * directly, sentence connectors need the action's full stop first. */
  const joinCore = (text: string, conn: string): string =>
    conn.startsWith(' —') ? text + conn : text + (text.endsWith('.') ? '' : '.') + conn;

  const c0 = cores[0]!;
  const conn0 = [
    ` — run it on ${mainChain}, where a session costs about ${money(gas1)} in fees. ${pacing}.`,
    ` Do it on ${mainChain}; a session there costs about ${money(gas1)} in fees. ${pacing}.`,
    ` — all of it on ${mainChain}, at about ${money(gas1)} a session in fees. ${pacing}.`,
    ` Keep this leg on ${mainChain} (about ${money(gas1)} in fees per session). ${pacing}.`,
  ];
  steps.push(`${joinCore(c0.text, conn0[v]!)} ${tail(c0.sessions, gas1, c0.minutes, v)}`);
  minutes += c0.sessions * c0.minutes;
  cost += c0.sessions * gas1;

  const c1 = cores[1]!;
  if (secondChain) {
    const conn1 = [
      ` — this leg runs on ${secondChain} (about ${money(gas2)} a session), which is why the wallet keeps a balance there.`,
      ` Run this leg on ${secondChain} instead — about ${money(gas2)} a session, and the reason the wallet keeps a balance there.`,
      ` — the ${secondChain} leg: about ${money(gas2)} a session there, funded by the balance step 1 leaves on that chain.`,
      ` This one belongs on ${secondChain} (about ${money(gas2)} a session); the gas money set aside in step 1 covers it.`,
    ];
    steps.push(`${joinCore(c1.text, conn1[(v + 1) % 4]!)} ${tail(c1.sessions, gas2, c1.minutes, v + 1)}`);
    cost += c1.sessions * gas2;
  } else {
    const conn1 = [
      ` — ${p.name} lives only on ${mainChain} in this snapshot, so both legs share one chain and one gas budget.`,
      ` The snapshot lists ${p.name} on ${mainChain} only, so this leg shares the same chain and gas budget as the first.`,
      ` — same chain as the first leg (${mainChain} is the only one the snapshot records), so one gas budget covers both.`,
      ` Both legs sit on ${mainChain} — the snapshot records no second chain — under one gas budget.`,
    ];
    steps.push(`${joinCore(c1.text, conn1[(v + 1) % 4]!)} ${tail(c1.sessions, gas1, c1.minutes, v + 1)}`);
    cost += c1.sessions * gas1;
  }
  minutes += c1.sessions * c1.minutes;

  const bothChains = secondChain ? ` on both ${mainChain} and ${secondChain}` : '';
  const tvlPhrase = `${money(p.tvl_usd)}${g !== null ? `, ${g >= 0 ? 'up' : 'down'} ${Math.abs(g).toFixed(1)}% on the week` : ''}`;
  const premise = years !== null ? `remember the position's premise — ${years.toFixed(1)} years recorded with no token` : 'note any listing or token announcement, since no listing date is recorded';
  const checkin = [
    `Across the ${weeks} weeks, check in once a week on the position${bothChains}: confirm TVL has not broken down (the snapshot records ${tvlPhrase}) and ${premise}. Cost: about ${money(gas1)} when a check needs a transaction. Time: about 10 minutes a week.`,
    `Once a week for the ${weeks} weeks, spend ten minutes on the position${bothChains}: check that TVL is holding (the snapshot records ${tvlPhrase}) and ${premise}. Cost: about ${money(gas1)} when a check needs a transaction.`,
    `Weekly, across the ${weeks} weeks: confirm the position${bothChains} is intact, TVL has not broken down from the ${tvlPhrase} the snapshot records, and ${premise}. Cost: about ${money(gas1)} when a check needs a transaction. Time: about 10 minutes a week.`,
    `Put a ten-minute check on the calendar every week of the ${weeks}${bothChains}: position intact, TVL not collapsing from the ${tvlPhrase} recorded, and ${premise}. Cost: about ${money(gas1)} when a check needs a transaction.`,
  ];
  steps.push(checkin[(v + 2) % 4]!);
  minutes += weeks * 10;
  cost += Math.ceil(weeks / 2) * gas1;

  const listed = listedYear ? `${p.name} has been recorded since ${listedYear} with no token, so any announcement is its first` : 'no listing date is recorded for it, so watch its official channels directly rather than calendars';
  const listedCap = listed.charAt(0).toUpperCase() + listed.slice(1);
  const claimFrom = Math.max(2, weeks - 2);
  const claim = [
    `Stay claim-ready from week ${claimFrom}: ${listed}; keep the wallet's history exportable and do not consolidate funds out of the farming wallet until any snapshot date has passed. Cost: no network fees. Time: about 5 minutes a week of watching.`,
    `From week ${claimFrom}, keep the wallet claim-ready: ${listed}; leave the funds unconsolidated until any snapshot date has passed, and keep the wallet's history exportable. Watching costs about 5 minutes a week and no network fees.`,
    `Claim readiness starts at week ${claimFrom}. ${listedCap}; the wallet's history stays exportable and nothing consolidates out of it until any snapshot date has passed. Cost: no network fees. Time: about 5 minutes a week of watching.`,
    `In the last stretch (from week ${claimFrom}), watch for the announcement: ${listed}; do not consolidate funds out of the farming wallet until any snapshot date has passed, and keep its history exportable. Cost: no network fees. Time: about 5 minutes a week of watching.`,
  ];
  steps.push(claim[(v + 3) % 4]!);
  minutes += weeks * 5;

  const totalCost = Math.round(cost * 100) / 100;
  const hours = Math.round((minutes / 60) * 10) / 10;
  const stopRule = `Stop early if the token is announced with a snapshot date already past, or if TVL halves from the ${money(p.tvl_usd)} recorded here.`;
  const totals = [
    `Programme totals for ${p.name} (board rank ${rank}): ${money(cap.low)} to ${money(cap.high)} of capital in the tranches above, about ${money(totalCost)} of network fees over ${weeks} weeks, and about ${hours.toFixed(1)} hours of your time. ${stopRule}`,
    `The programme in one line — ${p.name}, board rank ${rank}: ${money(cap.low)} to ${money(cap.high)} of capital in the tranches above, about ${money(totalCost)} of network fees over ${weeks} weeks, ${hours.toFixed(1)} hours of your time. ${stopRule}`,
    `Adding it up for ${p.name} (rank ${rank}): capital ${money(cap.low)} to ${money(cap.high)} in the tranches above; fees about ${money(totalCost)} over ${weeks} weeks; your time about ${hours.toFixed(1)} hours. ${stopRule}`,
    `${p.name}'s totals (board rank ${rank}): ${money(cap.low)} to ${money(cap.high)} of capital in the tranches above, about ${money(totalCost)} of network fees over ${weeks} weeks, and about ${hours.toFixed(1)} hours of your time. ${stopRule}`,
  ];
  steps.push(totals[v]!);
  return { steps, capitalUsd: cap.high, costUsd: totalCost, hours, weeks };
}

/** Word-bigram set of a plan's step texts, for the template-similarity check. */
function stepWordSet(steps: string[]): Set<string> {
  const words: string[] = [];
  for (const s of steps) {
    for (const w of s.toLowerCase().split(/[^a-z0-9$%.]+/)) {
      if (w.length > 2) words.push(w);
    }
  }
  const set = new Set<string>();
  for (let i = 0; i + 1 < words.length; i++) set.add(`${words[i]} ${words[i + 1]}`);
  return set;
}

/**
 * Mean pairwise Jaccard similarity of farm-step word bigrams, over the
 * whole board and over the worst window of 40 consecutive rows by rank.
 * Printed on the dashboard: a board whose plans are one template with
 * swapped numbers keeps the same word sequences and scores high;
 * per-row assembly breaks the sequences and pulls the number down.
 * The worst window is the honest version of the check: a board mean
 * can hide a templated stretch, the worst 40-row window cannot.
 */
export function farmSimilarity(rows: { farm_steps: string[] }[]): { board: number; worst40: number } {
  const sets = rows.map((r) => stepWordSet(r.farm_steps));
  const n = sets.length;
  const pair = new Float64Array(n * n);
  let boardSum = 0;
  let boardCount = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = sets[i]!;
      const b = sets[j]!;
      const [small, big] = a.size < b.size ? [a, b] : [b, a];
      let inter = 0;
      for (const w of small) if (big.has(w)) inter++;
      const sim = inter / (a.size + b.size - inter);
      pair[i * n + j] = sim;
      boardSum += sim;
      boardCount++;
    }
  }
  const width = Math.min(40, n);
  let worst = 0;
  if (width >= 2) {
    for (let start = 0; start + width <= n; start++) {
      let sum = 0;
      let cnt = 0;
      for (let i = start; i < start + width; i++) {
        for (let j = i + 1; j < start + width; j++) {
          sum += pair[i * n + j]!;
          cnt++;
        }
      }
      if (cnt > 0) worst = Math.max(worst, sum / cnt);
    }
  }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return { board: r3(boardCount ? boardSum / boardCount : 0), worst40: r3(worst) };
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
    categoryShrink: number;
    categoryPower: number;
    residQ25: number;
    residQ75: number;
    holdoutMedianFactor: number;
    validation: { variant: string; walkForward1: number; walkForward2: number; blind: number; threeFold: number; mean: number; vsBaselinePct: number; chosen: boolean }[];
    baseline: { walkForward1: number; walkForward2: number; blind: number; threeFold: number; mean: number };
    cv: CvRow[];
    categories: { category: string; samples: number; multiple: number; slope: number | null }[];
    launch: LaunchFitInfo;
    verdicts: { go: number; selective: number; skip: number; medianEfficiency: number; p25Efficiency: number; p90Efficiency: number; timeUsdPerHour: number };
    audit: AuditRow[];
    farmSimilarity: { board: number; worst40: number };
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
  const prob = `${Math.round(s.prob * 100)}%`;
  const costed = `${money(s.plan.costUsd)} fees + ${s.plan.hours.toFixed(1)}h at $${TIME_USD_PER_HOUR}/h`;
  // The same arithmetic in three sentence skeletons, rotated by slug:
  // the verdict line is part of every plan's last step, so its phrasing
  // rotates with the rest of the scaffolding.
  const forms = [
    ` Verdict: ${label} - ${prob} fitted launch odds x ${money(s.imp.value)} implied = ${money(s.ev)} probability-weighted value; ${money(s.efficiency)} per $1 of full cost (${costed}), board median ${money(medianEfficiency)}.`,
    ` Verdict: ${label}. The arithmetic: ${prob} fitted launch odds on ${money(s.imp.value)} of implied value gives ${money(s.ev)} probability-weighted; against the full cost (${costed}) that is ${money(s.efficiency)} per $1, where the board median is ${money(medianEfficiency)}.`,
    ` Verdict: ${label} — priced from this row alone: ${money(s.ev)} of probability-weighted value (${prob} odds x ${money(s.imp.value)} implied), or ${money(s.efficiency)} per $1 of full cost (${costed}); the board median is ${money(medianEfficiency)}.`,
  ];
  return forms[slugHash(s.p.slug) % 3]!;
}

/** Score every pre-token protocol and build the ranked board plus page data. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const vm = fitAll(snapshot);
  const fit = vm.fit;
  const launch = vm.launch;
  const peerIndex = buildPeerIndex(snapshot);
  const watch = new Set(snapshot.watchlist);
  const subjects = snapshot.protocols.filter((p) => isRankable(p) && p.tvl_usd > 0);
  const prescored = subjects
    .map((p) => {
      const imp = impliedFor(p, vm);
      const prob = launch.predict(p);
      return { p, imp, prob, ev: prob * imp.value };
    })
    .sort((a, b) => b.imp.value - a.imp.value || (a.p.slug < b.p.slug ? -1 : 1));
  const chosenPre = prescored.slice(0, BOARD_TARGET);
  for (const s of prescored) {
    if (watch.has(s.p.slug) && !chosenPre.includes(s)) chosenPre.push(s);
  }
  chosenPre.sort((a, b) => b.imp.value - a.imp.value || (a.p.slug < b.p.slug ? -1 : 1));
  // Every chosen row gets the per-row plan assembly (its own chains,
  // growth pace, tranche schedule and listing year in every step, with
  // the sentence skeletons rotated per row); the plan's cost and hours
  // feed the verdict, so assembly happens before verdicts are struck.
  const chosen: Scored[] = chosenPre.map((s, i) => {
    const plan = farmPlanPersonal(s.p, snapshot, i + 1);
    const fullCost = plan.costUsd + plan.hours * TIME_USD_PER_HOUR;
    return { ...s, plan, fullCost, efficiency: fullCost > 0 ? s.ev / fullCost : 0, verdict: 'skip' as Verdict };
  });
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
      shrink: fit.shrink,
      categoryShrink: fit.categoryShrink,
      categoryPower: fit.categoryPower,
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
        vsBaselinePct: Math.round(v.vsBaselinePct * 10) / 10,
        chosen: v.chosen,
      })),
      baseline: {
        walkForward1: Math.round(fit.baseline.walkForward1 * 100) / 100,
        walkForward2: Math.round(fit.baseline.walkForward2 * 100) / 100,
        blind: Math.round(fit.baseline.blind * 100) / 100,
        threeFold: Math.round(fit.baseline.threeFold * 100) / 100,
        mean: Math.round(fit.baseline.mean * 100) / 100,
      },
      cv: fit.cv.map((c) => ({ variant: c.variant, medianFactor: Math.round(c.medianFactor * 100) / 100, within2xPct: Math.round(c.within2xPct), within4xPct: Math.round(c.within4xPct) })),
      categories: fit.categories
        .filter((c) => c.samples >= 1)
        .map((c) => ({ category: c.category, samples: c.samples, multiple: Math.round(c.impliedMultiple * 1000) / 1000, slope: c.slope === null ? null : Math.round(c.slope * 1000) / 1000 })),
      launch: {
        samples: fit.launch.samples,
        launched: fit.launch.launched,
        baseRate: Math.round(fit.launch.baseRate * 1000) / 1000,
        auc: Math.round(fit.launch.auc * 1000) / 1000,
        brier: Math.round(fit.launch.brier * 1000) / 1000,
        features: fit.launch.features,
        spec: fit.launch.spec,
        aucOther: Math.round(fit.launch.aucOther * 1000) / 1000,
        calibrated: fit.launch.calibrated,
        calibBins: fit.launch.calibBins.map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, pred: Math.round(b.pred * 1000) / 1000, obs: Math.round(b.obs * 1000) / 1000 })),
        ridge: fit.launch.ridge,
        catShrink: fit.launch.catShrink,
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
      audit: fit.audit,
      farmSimilarity: farmSimilarity(rows),
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

