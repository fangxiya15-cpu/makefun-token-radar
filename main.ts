// Token launch radar (token-radar-01 entry, Node 22, standard library only).
//
// Reads the sealed snapshot at /input/snapshot.json (or --input <file|dir>),
// fits the value model in lib/model.ts on the snapshot's own priced
// protocols (four variants raced on walk-forward and blind holdouts,
// every remaining knob chosen by inner cross-validation), races two
// launch-odds specifications on a blind holdout, ranks the pre-token
// protocols by implied value with a costed farm verdict on every row,
// and writes:
//   /output/board.json     the ranked board (the gate reads this)
//   /output/data.js        the same board, as the dashboard's data
//   /output/dashboard/     a copy of this repository's dashboard/
//   /output/screenshots/   a copy of this repository's screenshots/
//   /output/dossier.json   the judge's dossier, written last with the
//                          vendored buildDossier, byte for byte as scored
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// The run is deterministic: the model is fitted from the snapshot alone,
// with no clock, no randomness and no network, so two runs of the same
// commit write the same bytes.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The dossier's text cap: the judge reads at most this many bytes of source. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> or --name=<value> out of the arguments, else the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const pageFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
// The dossier's text shows the dashboard's source whole only while it fits
// under the cap, headers included; a page past it is cut and the judge
// reads a partial source. Guard the budget here so an oversized page fails
// the build loudly instead of being truncated at grading time.
const pageBytes = pageFiles.reduce((sum, name) => sum + statSync(join(here, 'dashboard', name)).size, 0);
if (pageBytes > TEXT_MAX_BYTES - 4096) {
  process.stderr.write(`token radar: dashboard source is ${pageBytes} bytes: past the ${TEXT_MAX_BYTES}-byte dossier text budget once headers are counted\n`);
  process.exit(1);
}
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and
// compares bytes, so nothing may be written into /output after this line.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols scanned, ${radar.counts.preToken} record no token, ${radar.counts.eligible} launch candidates ranked, ${radar.counts.pricedComps} priced comparables fitted\n` +
    `token radar: board of ${board.length} rows, all ${snapshot.watchlist.length} watchlist protocols covered, holdout median factor ${radar.model.holdoutMedianFactor}\n` +
    `token radar: value model variant ${radar.model.variant} (${radar.model.featureCount} fitted terms); launch-odds ${radar.model.launch.spec} specification${radar.model.launch.calibrated ? ', Platt-calibrated' : ''}, holdout AUC ${radar.model.launch.auc} (other specification ${radar.model.launch.aucOther}), Brier ${radar.model.launch.brier}; verdicts go ${radar.model.verdicts.go} / selective ${radar.model.verdicts.selective} / skip ${radar.model.verdicts.skip}; farm-step similarity ${radar.model.farmSimilarity.board} board / ${radar.model.farmSimilarity.top40} top-40\n` +
    `token radar: top of the board: ${board.slice(0, 3).map((r) => `#${r.rank} ${r.slug} $${r.implied_value_usd.toLocaleString('en-US')}`).join('; ')}\n` +
    `token radar: wrote board.json, data.js, dashboard/ (${pageFiles.length} files, ${pageBytes} source bytes), screenshots/ (${shots.length} images) and dossier.json under ${out}\n`,
);
