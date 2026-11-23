// Token launch radar: the value model and the board builder.
//
// The model is fitted, at run time, from the sealed snapshot's own figures.
// Nothing about any individual protocol is written into this file: no name
// lists, no per-protocol constants. The only inputs are the snapshot's ten
// fields per protocol.
//
// Method, in the order the code runs it:
//   1. Comparable set: protocols whose token already trades at a measurable
//      cap (mcap_usd > 0). Protocols that record a token but no measurable
//      cap (mcap_usd <= 0 in the record) are set aside as "listed, unpriced"
//      and never used as evidence; protocols with no token recorded are the
//      board's subjects.
//   2. Level: an ordinary least squares line of log(mcap) on log(TVL) over
//      the comparable set. Market value grows slower than TVL (the fitted
//      slope lands near 0.5), so a raw TVL multiple would misrank sizes.
//   3. Category offsets: each category's median residual from that line,
//      shrunk toward zero by n / (n + 4), so a category with two samples
//      moves the estimate far less than one with fifteen.
//   4. Adjustments: the seven-day TVL change and the years a protocol has
//      run with no token are fitted on the residuals, then applied at a
//      quarter of their fitted strength. The snapshot's own cross-validation
//      (printed in the dashboard's method panel) shows the full-strength
//      terms overfit; a quarter strength keeps the radar responsive to
//      growth and track record at a small, measured calibration cost.
//   5. Interval: the estimate's range is the fitted value shifted by the
//      category's residual quartiles (shrunk toward the global quartiles),
//      because the honest finding of the fit is that value given TVL is a
//      range, not a point: the typical miss is a factor of about four.
//
// Validation is deterministic: the comparable set is split into three folds
// by slug order, the model is refitted on two folds and scored on the third,
// and the median factor error of each model variant is carried into the
// dashboard so a reader can see exactly how much the numbers can be trusted.

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
}

export interface CvRow {
  variant: string;
  medianFactor: number;
  within2xPct: number;
  within4xPct: number;
}

export interface ModelFit {
  samples: number;
  unpricedListed: number;
  slope: number;
  intercept: number;
  growthCoef: number; // per +1% of seven-day change, after shrink
  ageCoef: number; // per year with no token, after shrink
  categories: CategoryFit[];
  residQ25: number;
  residQ75: number;
  cv: CvRow[];
  holdoutMedianFactor: number;
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

/** Fit the production model on every priced comparable in the snapshot. */
export function fitModel(snapshot: Snapshot): ModelFit {
  const priced = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const unpricedListed = snapshot.protocols.filter((p) => !recordsNoToken(p) && (p.mcap_usd === null || p.mcap_usd <= 0)).length;
  const raw = fitRaw(priced, snapshot.as_of, ADJUSTMENT_SHRINK);
  const categories: CategoryFit[] = [...raw.offsets.entries()]
    .map(([category, v]) => ({ category, samples: v.n, offset: v.offset, rawMedianResidual: v.raw, impliedMultiple: Math.exp(v.offset) }))
    .sort((a, b) => b.samples - a.samples || (a.category < b.category ? -1 : 1));
  const cvLevel = crossValidate(priced, snapshot.as_of, 0);
  const cvApplied = crossValidate(priced, snapshot.as_of, ADJUSTMENT_SHRINK);
  const cvFull = crossValidate(priced, snapshot.as_of, 1);
  return {
    samples: priced.length,
    unpricedListed,
    slope: raw.slope,
    intercept: raw.intercept,
    growthCoef: raw.growthCoef,
    ageCoef: raw.ageCoef,
    categories,
    residQ25: quartile(raw.globalResid, 0.25),
    residQ75: quartile(raw.globalResid, 0.75),
    cv: [
      { variant: 'TVL curve + category offsets only', medianFactor: cvLevel.medianFactor, within2xPct: cvLevel.within2x * 100, within4xPct: cvLevel.within4x * 100 },
      { variant: 'plus growth & track-record terms at 1/4 strength (this board)', medianFactor: cvApplied.medianFactor, within2xPct: cvApplied.within2x * 100, within4xPct: cvApplied.within4x * 100 },
      { variant: 'plus growth & track-record terms at full strength', medianFactor: cvFull.medianFactor, within2xPct: cvFull.within2x * 100, within4xPct: cvFull.within4x * 100 },
    ],
    holdoutMedianFactor: cvApplied.medianFactor,
  };
}

export interface Implied {
  value: number;
  low: number;
  high: number;
  baseLog: number;
  categoryOffset: number;
  growthAdj: number;
  ageAdj: number;
  multiple: number; // value / tvl
}

/** One protocol's implied value and the decomposition behind it. */
export function impliedFor(p: SnapshotProtocol, snapshot: Snapshot, fit: ModelFit, raw: RawFit): Implied {
  const logV = raw.predict(p);
  const catResid = raw.residuals.get(p.category ?? '(uncategorised)');
  const w = catResid ? catResid.length / (catResid.length + CATEGORY_SHRINK) : 0;
  const q25 = catResid ? w * quartile(catResid, 0.25) + (1 - w) * fit.residQ25 : fit.residQ25;
  const q75 = catResid ? w * quartile(catResid, 0.75) + (1 - w) * fit.residQ75 : fit.residQ75;
  const value = Math.max(1, Math.round(Math.exp(logV)));
  return {
    value,
    low: Math.max(1, Math.round(Math.exp(logV + q25))),
    high: Math.round(Math.exp(logV + q75)),
    baseLog: fit.intercept + fit.slope * Math.log(p.tvl_usd),
    categoryOffset: raw.offsets.get(p.category ?? '(uncategorised)')?.offset ?? 0,
    growthAdj: fit.growthCoef * growthClamped(p),
    ageAdj: fit.ageCoef * ((ageDays(snapshot.as_of, p.listed_at) ?? 730) / 365.25),
    multiple: value / p.tvl_usd,
  };
}

/** Refit helper kept beside fitModel so main.ts holds one fit object. */
export function fitAll(snapshot: Snapshot): { fit: ModelFit; raw: RawFit } {
  const priced = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  return { fit: fitModel(snapshot), raw: fitRaw(priced, snapshot.as_of, ADJUSTMENT_SHRINK) };
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
    `Programme totals for ${p.name}: ${money(cap.low)} to ${money(cap.high)} of capital at work (returned if the positions behave), about ${money(totalCost)} of network fees over ${weeks} weeks, and about ${(minutes / 60).toFixed(1)} hours of your time. Stop early if the protocol announces its token with a snapshot date already past, or if TVL halves from the ${money(p.tvl_usd)} the snapshot records.`,
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
  parts: { base: number; category: number; growth: number; age: number };
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
    slope: number;
    intercept: number;
    growthCoefPerPct: number;
    ageCoefPerYear: number;
    shrink: number;
    residQ25: number;
    residQ75: number;
    holdoutMedianFactor: number;
    cv: CvRow[];
    categories: { category: string; samples: number; multiple: number }[];
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

/** Score every pre-token protocol and build the ranked board plus page data. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const { fit, raw } = fitAll(snapshot);
  const watch = new Set(snapshot.watchlist);
  const subjects = snapshot.protocols.filter((p) => isRankable(p) && p.tvl_usd > 0);
  const scored = subjects
    .map((p) => ({ p, imp: impliedFor(p, snapshot, fit, raw), plan: farmPlan(p, snapshot) }))
    .sort((a, b) => b.imp.value - a.imp.value || (a.p.slug < b.p.slug ? -1 : 1));
  const chosen = scored.slice(0, BOARD_TARGET);
  for (const s of scored) {
    if (watch.has(s.p.slug) && !chosen.includes(s)) chosen.push(s);
  }
  chosen.sort((a, b) => b.imp.value - a.imp.value || (a.p.slug < b.p.slug ? -1 : 1));
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
      },
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
      slope: Math.round(fit.slope * 1000) / 1000,
      intercept: Math.round(fit.intercept * 1000) / 1000,
      growthCoefPerPct: Math.round(fit.growthCoef * 10000) / 10000,
      ageCoefPerYear: Math.round(fit.ageCoef * 10000) / 10000,
      shrink: ADJUSTMENT_SHRINK,
      residQ25: Math.round(fit.residQ25 * 1000) / 1000,
      residQ75: Math.round(fit.residQ75 * 1000) / 1000,
      holdoutMedianFactor: Math.round(fit.holdoutMedianFactor * 100) / 100,
      cv: fit.cv.map((c) => ({ variant: c.variant, medianFactor: Math.round(c.medianFactor * 100) / 100, within2xPct: Math.round(c.within2xPct), within4xPct: Math.round(c.within4xPct) })),
      categories: fit.categories.filter((c) => c.samples >= 2).map((c) => ({ category: c.category, samples: c.samples, multiple: Math.round(c.impliedMultiple * 1000) / 1000 })),
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

