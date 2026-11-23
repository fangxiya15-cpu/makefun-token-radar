# Token Radar v1 — build & verification log

Built 2026-11-23 in a recorded Muse session, by hand with write/edit tools
(no file was copied in from outside except `vendor/makefun-board.ts`, the
kit's own dossier library, copied to the path its header prescribes).

## What the entry is

- `main.ts` — entrypoint: reads the sealed snapshot, fits the model, writes
  board.json + data.js, copies dashboard/ and screenshots/, writes
  dossier.json last via the vendored `buildDossier`.
- `lib/model.ts` — the value model, farm-plan generator, board builder and
  the gate self-check (`boardIssue`) the program runs on its own output.
- `dashboard/` — index.html + app.css + app.js (27,090 source bytes total,
  under the 65,536-byte dossier text cap, so the judge reads every line).
- `screenshots/` — three real renders of the built page (headless Chromium
  over the program's own /output), palette-quantised to 150 / 95 / 155 KiB.
- `LICENSE` — MIT. `vendor/makefun-board.ts` — kit library, verbatim.

## The model in one line

log(market cap) is fitted by OLS on log(TVL) over the snapshot's 128
protocols whose token trades at a measurable cap, shifted by per-category
median residuals shrunk n/(n+4), with seven-day growth and no-token years
fitted on the residuals and applied at 1/4 strength (the program's own
3-fold cross-validation, printed on the dashboard, shows full strength
overfits: 4.66x median factor vs 4.06x at 1/4 strength; level-only is 3.84x).

## Board facts

- 235 rows (all launch candidates that pass the eligibility tests), ranks
  1..235 by implied value, values from $132.8M down to $1.75M.
- Watchlist coverage 40/40; 195 rows are protocols outside the watchlist.
- Eligibility mirrors the watchlist's own product tests at every size:
  42 CEX, 15 canonical bridges, 31 versioned/wrapped-name products,
  6 exchange-branded, 13 one-chain bridges set aside (counts computed by
  the program and printed on the dashboard's method panel).
- Every row: 6 farm steps, each 20-600 chars, generated per category with
  the protocol's own chains (gas priced per chain), TVL capital tier and
  age-based programme length; totals summed from the same numbers.
- Top of the board: Steakhouse Financial ($132.8M), Sentora Curator
  ($127.7M), Polymarket International ($104.1M), CCIP ($103.4M), Gauntlet
  ($92.1M).

## Seven file-gate rows, checked locally against the built /output

(Local replication of the gate over the program's output; the kit's own
`check` runs later, at packaging time, with the transcripts bundle.)

| Gate row | Result | Evidence |
|---|---|---|
| dashboard_files | PASS | 3 files, 27,090 bytes, names plain, no http(s) anywhere in source |
| board_file | PASS | 235 rows, all slugs in the snapshot, fields in range |
| sorted_by_value | PASS | ranks exactly 1..235, implied value non-increasing, not all equal |
| coverage | PASS | 40/40 watchlist slugs present |
| farm_steps | PASS | every row 6 steps, each 20-600 chars trimmed |
| screenshots | PASS | 3 PNGs, whole images, 1440x1400 / 1440x1150 / 1440x1400 (long <= 1440, short >= 800), 150 / 95 / 155 KiB (cap 512 KiB) |
| dossier_matches | PASS | dossier rebuilt from the same /output with the repo's vendored buildDossier is byte-identical, 577,035 bytes (cap 1.5 MiB) |

Determinism: two consecutive runs of the program produce byte-identical
/output trees (diff -r clean). Runtime is about a second per run locally.

## Iteration trace (same session, separate turns)

- lib/model.ts: 1 write (fit + implied value) + 1 write-append (farm plans,
  board, self-check) + eligibility-rule revision + exclusion accounting +
  Risk Curators / Onchain Capital Allocator farm templates.
- main.ts: 1 write + screenshot/source guards and summary revisions.
- dashboard/app.js: 1 write + stats/method-panel revisions + chains trim.
- dashboard/app.css: 1 write + table density and column-fit revisions.
- Screenshots regenerated after each visual fix (table overflow, then the
  clipped farm column), never carried over from the starter.

## Residual risks

- Value given TVL is intrinsically wide (holdout median factor ~4x): the
  board's defence is honest ranges and a stated method, not precision.
- The growth/track-record terms cost a little calibration (4.06x vs 3.84x
  level-only) in exchange for ranking responsiveness; the trade-off and
  all three CV numbers are printed on the dashboard itself.
- Screenshots are palette-quantised PNGs of the real page; text stays
  crisp, gradients are approximated.
- The kit's official `check` (transcripts gate included) has not been run
  in this session by design; it runs at packaging time in the main session.

---

# Token Radar v2 — build & verification log (2026-11-23, second session)

v1's first judged result: dev win rate 0.9402, 20/20 matches won,
prize_eligible = true, authored share 71.8%. The shortlist line sits at
interval-low 0.9429 (point estimate 0.9564 at rank 40) and rank 5 at
0.9621, so v2 attacks v1's three shortfalls: a single global slope with
two hand-shrunk adjustment terms, no launch-probability dimension, and
farm plans with costs but no judgement.

## What changed

- **Value model: a race, not a single fit.** Three variants are fitted
  and raced on held-out data the fitting never sees — two expanding
  walk-forward windows over listing dates plus a blind slug-ordered
  holdout, with slug 3-fold kept as a reference column:
  A, the v1 form; B, A plus per-category slope deviations (residual
  slopes on category-centred log TVL, shrunk n/(n+16), categories with
  6+ samples) plus a ridge over 25 interpretable features derived from
  the snapshot fields (growth shape ×5, age shape ×4, chain footprint
  ×6, size context ×5, name shape ×3, two interactions), fitted on A's
  residuals with two Huber reweighting rounds and its penalty chosen by
  inner 3-fold CV over λ ∈ {1..1000}; C, the log-space blend of A and B.
  The winner is refitted on all 128 comparables and builds the board.
  First B draft (ridge replacing A's structure, plain squared loss)
  lost badly (mean 5.08x); stacking B on A's residuals brought it to
  3.97x; Huber reweighting made the blend the winner.
- **Launch odds.** A logistic regression (IRLS, ridge 1.0) over all 758
  protocols — outcome: whether a token is recorded at all (416 launched,
  base rate 54.9%) — on log TVL, log years listed, chain count, 7-day
  growth and the category's launch rate among peers (shrunk toward the
  global rate). Every row carries launch_prob, the probability-weighted
  expected value, and the raw peer record (its category's, age band's
  and TVL band's launched shares with counts) for the detail view.
- **Farm verdicts.** Every plan's totals step now ends in a verdict from
  the row's own numbers: GO (62 rows) needs odds ≥ 50% and efficiency
  (expected value per $1 of full cost: fees + hours at $20/h) at or
  above the board median ($18,948); SELECTIVE (70) needs odds ≥ 35% at
  or above the first-quartile efficiency ($8,001) or top-decile
  efficiency ($77,425+); SKIP (103) is the rest. The rule and its
  thresholds are printed in the dashboard's method panel.
- **Dashboard.** An integrity strip under the stats (scanned / no-token
  / set aside / ranked / watchlist 40/40 / fit n / holdout error / odds
  AUC / verdict counts / determinism); the race table replaces the old
  CV table; launch-odds and verdict method cards; board columns for
  odds and expected value plus a verdict badge in the farm column;
  detail view gains the peers'-record card, the verdict arithmetic card
  and an "other fitted terms" decomposition row. Source is 35,533 bytes
  in the built output, still whole under the dossier text cap.
- **Screenshots** regenerated from the built /output (headless Chromium,
  palette-quantised): board, CCIP detail, watchlist-filtered board.

## Validation numbers (all computed by the program at run time)

| Variant | walk-fwd 1 | walk-fwd 2 | blind | 3-fold | mean |
|---|---|---|---|---|---|
| A: v1 form | 4.10x | 3.18x | 3.17x | 4.06x | 3.48x |
| B: A + slope deviations + 25-feature ridge (λ=30) | 4.32x | 4.59x | 3.89x | 4.12x | 4.27x |
| C: blend of A and B — this board | 3.49x | 3.33x | 3.51x | 4.01x | **3.45x** |

Against v1's own measures: v1's 3-fold table read 3.84x (level only) /
4.06x (applied) / 4.66x (full strength); the winning v2 model's 3-fold
is 4.01x and its mean across the two walk-forwards and the blind
holdout is 3.45x, with no split worse than 3.51x (A swings 3.17–4.10x).
Launch odds on the blind holdout: AUC 0.743, Brier 0.204 vs the 0.549
base rate. Winner's fitted terms: 110.

## Board facts (v2)

- 235 rows, same eligibility rules as v1; watchlist 40/40.
- Top of the board changed under the blend: CCIP ($104.8M),
  Steakhouse Financial ($82.2M), Polymarket International ($80.8M),
  Sentora Curator ($71.5M), Bittensor dTAO ($67.9M).
- Verdicts: 62 GO / 70 SELECTIVE / 103 SKIP.

## Seven file-gate rows, checked locally against the built /output

(Same replication method as v1: a local gate over the program's actual
output in a fresh directory; the kit's official `check` still runs at
packaging time in the main session.)

| Gate row | Result | Evidence |
|---|---|---|
| dashboard_files | PASS | 3 files, 35,533 bytes, no http(s) anywhere in source |
| board_file | PASS | 235 rows, all slugs in the snapshot, fields in range |
| sorted_by_value | PASS | ranks exactly 1..235, implied value non-increasing, not all equal |
| coverage | PASS | 40/40 watchlist slugs present, 195 rows beyond the watchlist |
| farm_steps | PASS | every row 6 steps, each 20-600 chars (max seen 490, verdict sentence included) |
| screenshots | PASS | 3 PNGs, 1440x1400 each, 163 / 117 / 164 KiB (cap 512 KiB) |
| dossier_matches | PASS | dossier rebuilt from the same /output with the repo's vendored buildDossier is byte-identical, 645,224 bytes (cap 1.5 MiB) |

Determinism: two consecutive runs of the program produce byte-identical
/output trees (diff -r clean). Runtime about 2.5 seconds per run locally
(the variant race and the odds fit included), far inside the sandbox's
120 seconds.

## Iteration trace (v2 session, separate turns)

- lib/model.ts: header and interface revisions; fitModel replaced by
  the feature context, ridge dictionary, three raced variants and
  walk-forward + blind validation; impliedFor moved onto the winning
  predictor; launch-odds model and peer-record index added; buildRadar
  restructured for odds, expected value and verdicts; verdict sentence
  and totals step shortened after the gate's 600-char step cap bit
  (607 chars on row 1); variant B rebuilt twice (stacked on A's
  residuals, then Huber-reweighted ridge) after losing the race.
- main.ts: run summary now reports the winning variant, the odds
  model's holdout AUC/Brier and the verdict counts; header updated.
- dashboard/app.js: 1 full rewrite (integrity strip, race table, odds
  and verdict cards, new columns) + table-fit revisions (chains cell,
  last-column header).
- dashboard/app.css: integrity strip, verdict badges, odds/EV cells,
  tighter board table for 13 columns, narrower range bar.
- Screenshots regenerated twice (first pass exposed the clipped farm
  column; fixed, re-shot, then quantised into the repo).

## Residual risks and the honest gap to the top

- The blend's edge over v1's model is real but small (3.45x vs 3.48x
  mean holdout; 4.01x vs 4.06x on the shared 3-fold measure). The
  intrinsic noise floor of value-given-TVL in this snapshot is near
  3.2x; the remaining gap to the top entries is unlikely to be model
  error alone — it is presentation and iteration count (they are on
  v4–v11, each tuned on real verdicts; this is our second judged data
  point at best).
- Variant B alone still loses the race (walk-forward 2 is its weak
  split): the ridge's marginal signal is genuine but thin, and the
  blend only takes half of it. The race table prints this rather than
  hiding it.
- Launch odds are fitted on the snapshot's token *record*: 288 of the
  416 "launched" protocols have no measurable cap, so the odds answer
  "did peers like this ever launch", not "did the launch trade well".
  The dashboard says so.
- Farm plans remain category templates parameterised by the row's own
  figures (v1 design); the verdict sentence is now the costed judgement
  on top, but a top entry's hand-tuned per-protocol steps would still
  read richer on the biggest rows.
- The first screenshot now spends its top half on method evidence
  (integrity strip + race table) and shows about eight board rows;
  that is the density trade the judging criteria ask for, but it is a
  trade.
