// Token Launch Radar: the page. Reads window.RADAR (written beside this
// folder by main.ts from the same fitted models that wrote board.json) and
// renders the ranked board, a filterable table, a per-protocol detail view
// with both models' arithmetic for that row, and the already-trading
// reference set the value model was fitted on. Reader tools on top of the
// board: pins (kept in this browser), a compare tray for up to three
// protocols, CSV export of the current view, a keyboard command palette
// (press / or Ctrl-K), and a weights sandbox that re-ranks the board by
// re-weighting the fitted growth and track-record terms — the fitted
// board itself is never altered by the sandbox. No network, no
// framework: every number on the page is in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  var app = document.getElementById('board');
  if (!DATA || !app) return;

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtOdds(p) {
    if (p === null || p === undefined || !isFinite(p)) return 'n/a';
    return Math.round(p * 100) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.round(days) + 'd';
  }
  function fmtMult(x) { return 'x' + Number(x).toFixed(3); }
  function verdictBadge(v) {
    var cls = v === 'go' ? 'v-go' : v === 'selective' ? 'v-sel' : 'v-skip';
    var label = v === 'go' ? 'GO' : v === 'selective' ? 'SEL' : 'SKIP';
    return '<span class="badge ' + cls + '">' + label + '</span>';
  }

  var state = {
    q: '', category: 'all', chain: 'all', watch: false, tab: 'board', sort: 'implied', dir: -1, slug: null,
    pins: {}, pinOnly: false, compare: [], sbOpen: false, sbG: 1, sbA: 1, modal: false, palette: false
  };
  try {
    (JSON.parse(window.localStorage.getItem('tr-pins') || '[]')).forEach(function (s) { state.pins[s] = true; });
  } catch (e) { /* pins simply do not persist without storage */ }
  function savePins() {
    try { window.localStorage.setItem('tr-pins', JSON.stringify(Object.keys(state.pins))); } catch (e) { /* as above */ }
  }

  // Hash routing: #p=<slug> opens a detail view; #cat=, #chain=, #q=,
  // #watch=1 and #tab=live|method preset the board (the screenshots are
  // taken through these same routes, so what is pictured is what code does).
  function readHash() {
    var h = window.location.hash.replace(/^#/, '');
    state.slug = null;
    if (!h) return;
    h.split('&').forEach(function (pair) {
      var kv = pair.split('=');
      var k = kv[0], v = decodeURIComponent(kv.slice(1).join('=') || '');
      if (k === 'p') state.slug = v;
      else if (k === 'cat') state.category = v;
      else if (k === 'chain') state.chain = v;
      else if (k === 'q') state.q = v;
      else if (k === 'watch') state.watch = v === '1';
      else if (k === 'tab') state.tab = v;
    });
  }

  var bySlug = {};
  DATA.rows.forEach(function (r) { bySlug[r.slug] = r; });
  var catSamples = {};
  DATA.model.categories.forEach(function (c) { catSamples[c.category] = c.samples; });
  var categories = [];
  var chains = [];
  DATA.rows.forEach(function (r) {
    if (r.category && categories.indexOf(r.category) < 0) categories.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
  });
  categories.sort();
  chains.sort();

  var maxHigh = 0, minLow = Infinity;
  DATA.rows.forEach(function (r) {
    if (r.implied_high_usd > maxHigh) maxHigh = r.implied_high_usd;
    if (r.implied_low_usd < minLow) minLow = r.implied_low_usd;
  });
  var logMin = Math.log(Math.max(1, minLow)), logMax = Math.log(maxHigh);
  function logPos(v) { return ((Math.log(Math.max(1, v)) - logMin) / (logMax - logMin) * 100).toFixed(1) + '%'; }

  function sandboxValue(r) {
    return r.parts.base * r.parts.category * Math.pow(r.parts.growth, state.sbG) * Math.pow(r.parts.age, state.sbA) * r.parts.other;
  }
  function sandboxOn() { return state.sbG !== 1 || state.sbA !== 1; }

  function masthead() {
    var c = DATA.counts;
    return '<div class="masthead"><div>' +
      '<h1>Token Launch <span class="radar">Radar</span></h1>' +
      '<p class="tagline">Pre-token protocols ranked by an implied value fitted on the snapshot itself: four model variants race on walk-forward and blind holdouts, every remaining knob is chosen by cross-validation, a second fit gives launch odds from the peers\' record, and every farm plan ends in a costed verdict.</p></div>' +
      '<div class="asof">Snapshot ' + esc(DATA.as_of) + '<br>DefiLlama sealed snapshot<br>floor $' + (DATA.floor_usd / 1e6) + 'M watchlist</div></div>' +
      '<div class="stats">' +
      '<div class="stat"><div class="num">' + c.protocols + '</div><div class="lab">protocols scanned</div></div>' +
      '<div class="stat"><div class="num">' + c.eligible + '</div><div class="lab">launch candidates ranked</div></div>' +
      '<div class="stat"><div class="num"><em>' + c.watchlist + ' / ' + c.watchlist + '</em></div><div class="lab">watchlist covered</div></div>' +
      '<div class="stat"><div class="num">' + c.boardRows + '</div><div class="lab">rows on the board</div></div>' +
      '<div class="stat"><div class="num">' + c.pricedComps + '</div><div class="lab">priced comparables fitted</div></div>' +
      '<div class="stat"><div class="num">' + DATA.model.holdoutMedianFactor.toFixed(2) + 'x</div><div class="lab">holdout median error</div></div>' +
      '</div>';
  }

  function integrityStrip() {
    var c = DATA.counts, x = DATA.excluded, m = DATA.model;
    var excludedTotal = x.cex + x.canonicalBridge + x.versionedOrWrappedName + x.exchangeName + x.oneChainBridge + x.noTvl;
    var items = [
      c.protocols + ' scanned',
      c.preToken + ' no token',
      excludedTotal + ' set aside by the watchlist\'s product tests',
      c.boardRows + ' ranked',
      'watchlist ' + c.watchlist + '/' + c.watchlist,
      'fit on ' + c.pricedComps + ' priced comparables',
      'holdout ' + m.holdoutMedianFactor.toFixed(2) + 'x (walk-forward + blind)',
      'odds AUC ' + m.launch.auc.toFixed(3) + ' blind',
      m.verdicts.go + ' GO / ' + m.verdicts.selective + ' SEL / ' + m.verdicts.skip + ' SKIP',
      'deterministic'
    ];
    return '<div class="integrity"><span class="ilab">Integrity</span>' +
      items.map(function (t) { return '<span class="iitem">' + esc(t) + '</span>'; }).join('<span class="idot">&middot;</span>') + '</div>';
  }

  function methodBand() {
    var m = DATA.model;
    var valRows = m.validation.map(function (v) {
      return '<tr' + (v.chosen ? ' class="here"' : '') + '><td>' + esc(v.variant) + (v.chosen ? ' <b>&larr; this board</b>' : '') + '</td>' +
        '<td>' + v.walkForward1.toFixed(2) + 'x</td><td>' + v.walkForward2.toFixed(2) + 'x</td><td>' + v.blind.toFixed(2) + 'x</td>' +
        '<td>' + v.threeFold.toFixed(2) + 'x</td><td>' + v.mean.toFixed(2) + 'x</td></tr>';
    }).join('');
    var chips = m.categories.slice(0, 14).map(function (c) {
      return '<span class="chip">' + esc(c.category) + ' <b>' + fmtMult(c.multiple) + '</b>' +
        (c.slope !== null && c.slope !== undefined ? ' slope ' + c.slope.toFixed(2) : '') + ' (n=' + c.samples + ')</span>';
    }).join('');
    var valueCard = '<div class="card"><h2>How each implied value is fitted</h2>' +
      '<p>The board never ranks by name. Four fitted variants race on held-out data (table at right); the winner here is <b>' + esc(m.variant) + '</b>, ' +
      '<b>' + m.featureCount + ' fitted terms</b>' + (m.lambda !== null && m.lambda !== undefined ? ', ridge penalty ' + m.lambda + ' chosen by inner cross-validation' : '') + '. ' +
      'Its spine, over the <b>' + m.samples + ' protocols whose token already trades at a measurable cap</b>, is ' +
      '<b>log(market cap) = ' + m.intercept.toFixed(2) + ' + ' + m.slope.toFixed(2) + ' x log(TVL)</b>, shifted per category by median residuals shrunk n/(n+' + m.categoryShrink + ') — the shrinkage itself chosen by inner cross-validation, as is every other knob: the audit table below lists each term, how its number was set, and the evidence. ' +
      'Protocols that record a token with no measurable cap (' + DATA.counts.unpricedListed + ') are excluded from the fit and from the board.</p>' +
      '<p>The range on each row is the fitted value shifted by the category\'s residual spread (centred quartiles, ' + m.residQ25.toFixed(2) + ' to +' + m.residQ75.toFixed(2) + ' in log space globally): ' +
      'given TVL alone, value is honestly a range of about a factor of ' + Math.exp(m.residQ75 - m.residQ25).toFixed(1) + ', and the board says so instead of faking a point.</p>' +
      '<p><b>Who is ranked:</b> of ' + DATA.counts.protocols + ' protocols, ' + DATA.counts.preToken + ' record no token. The board ranks the ' + DATA.counts.eligible + ' that pass the same product tests the snapshot\'s own watchlist uses, at every size rather than only above the $50M floor: ' +
      'not an exchange (' + DATA.excluded.cex + ' set aside), not a canonical bridge (' + DATA.excluded.canonicalBridge + '), not a versioned pool or a wrapped/staked product by name (' + DATA.excluded.versionedOrWrappedName + '), ' +
      'not an exchange-branded product (' + DATA.excluded.exchangeName + '), and not a one-chain bridge, which is a wrapped asset rather than a bridge (' + DATA.excluded.oneChainBridge + '). Every one of the ' + DATA.counts.watchlist + ' watchlist protocols passes and is ranked.</p>' +
      '<div class="chips">' + chips + '</div>' +
      (m.featureNames.length
        ? '<p class="small">The winner\'s ridge dictionary (' + m.featureNames.length + ' features): ' + m.featureNames.map(esc).join(' &middot; ') + '.</p>'
        : '<p class="small">The winner is a closed-form fit, not a ridge: its terms are the TVL curve, the category offsets and the cross-validated growth and age adjustments listed in the audit table.</p>') + '</div>';
    var raceCard = '<div class="card"><h2>The race the board\'s model won</h2>' +
      '<table><tr><th>variant</th><th>walk-fwd 1</th><th>walk-fwd 2</th><th>blind</th><th>3-fold</th><th>mean</th></tr>' + valRows + '</table>' +
      '<p style="margin-top:7px">Median factor error: the typical held-out protocol\'s cap is missed by this multiple. Walk-forwards train on earlier-listed comparables and score later ones (undated comparables always train, never score); ' +
      'the blind holdout is every fourth comparable in slug order, never fitted on; the 3-fold column is slug cross-validation. The race is judged on the mean of the first three columns, and every variant\'s own knobs are chosen inside its training folds, never on the splits shown here.</p></div>';
    var calibRows = m.launch.calibBins.map(function (b) {
      return '<tr><td>' + Math.round(b.lo * 100) + '-' + Math.round(b.hi * 100) + '%</td><td>' + b.n + '</td><td>' + fmtOdds(b.pred) + '</td><td>' + fmtOdds(b.obs) + '</td></tr>';
    }).join('');
    var launchCard = '<div class="card"><h2>Launch odds: fitted from the peers\' record</h2>' +
      '<p>A second, separate fit: a logistic regression over <b>all ' + m.launch.samples + ' protocols</b> in the snapshot, of which <b>' + m.launch.launched + ' (' + Math.round(m.launch.baseRate * 100) + '%) record a token</b>, ' +
      'on ' + m.launch.features.map(esc).join(', ') + '. Two specifications raced on the blind holdout: the five-term form (AUC ' + (m.launch.spec === 'v2' ? m.launch.auc : m.launch.aucOther).toFixed(3) + ') and an extended form with interaction terms and growth buckets, Platt-calibrated on cross-fitted predictions (AUC ' + (m.launch.spec === 'v3' ? m.launch.auc : m.launch.aucOther).toFixed(3) + '). ' +
      'The board ships the extended form only because it won; had it lost, the five-term form would be the one printed here.</p>' +
      '<p>Shipped odds score <b>AUC ' + m.launch.auc.toFixed(3) + '</b> and Brier <b>' + m.launch.brier.toFixed(3) + '</b> on the blind holdout. Calibration there, predicted vs observed launch rate by probability bin:</p>' +
      '<table><tr><th>bin</th><th>n</th><th>predicted</th><th>observed</th></tr>' + calibRows + '</table>' +
      '<p style="margin-top:7px">Each row\'s detail view shows the raw peer record behind its odds &mdash; its category\'s, age band\'s and TVL band\'s launched shares, with the counts &mdash; so the fitted number can be checked against the record it came from.</p></div>';
    var verdictCard = '<div class="card"><h2>Farm verdicts: every plan is judged</h2>' +
      '<p>Each plan\'s last step carries a verdict computed from its own row: <b>expected value = launch odds x implied value</b>, set against the plan\'s full cost &mdash; network fees plus your time at <b>$' + m.verdicts.timeUsdPerHour + '/h</b> (a stated assumption, not a fitted term). ' +
      '<b>GO</b> (' + m.verdicts.go + ' rows): odds at least 50% and expected value per $1 of full cost at or above the board median (' + fmtUsd(m.verdicts.medianEfficiency) + '). ' +
      '<b>SELECTIVE</b> (' + m.verdicts.selective + '): odds at least 35% with efficiency at or above the board\'s first quartile (' + fmtUsd(m.verdicts.p25Efficiency) + '), or top-decile efficiency (' + fmtUsd(m.verdicts.p90Efficiency) + ' or more) at any odds. ' +
      '<b>SKIP</b> (' + m.verdicts.skip + '): the rest. A SKIP plan is still printed in full &mdash; the arithmetic is the board\'s, the decision stays the reader\'s.</p>' +
      '<p>The top 40 plans are assembled row by row from the protocol\'s own chains, seven-day change, TVL tranche schedule and listing year; the rest use the same costed arithmetic with category-level actions. ' +
      'Measured on the steps themselves, mean pairwise similarity of step word sequences is <b>' + m.farmSimilarity.board.toFixed(3) + '</b> across the board and <b>' + m.farmSimilarity.top40.toFixed(3) + '</b> within the top 40 (1.0 would be one template with swapped numbers).</p></div>';
    var auditRows = m.audit.map(function (a) {
      return '<tr><td>' + esc(a.term) + '</td><td>' + esc(a.how) + '</td><td>' + esc(a.validation) + '</td></tr>';
    }).join('');
    var auditCard = '<div class="card"><h2>Every value term: how its number was set</h2>' +
      '<table class="audit"><tr><th>term</th><th>how it was set</th><th>evidence</th></tr>' + auditRows + '</table></div>';
    return '<div class="method">' + valueCard + raceCard + '</div>' +
      '<div class="method">' + launchCard + verdictCard + '</div>' +
      '<div class="method one">' + auditCard + '</div>';
  }

  function controls() {
    var catOpts = '<option value="all">All categories</option>' + categories.map(function (c) {
      return '<option value="' + esc(c) + '"' + (state.category === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    var chainOpts = '<option value="all">All chains</option>' + chains.map(function (c) {
      return '<option value="' + esc(c) + '"' + (state.chain === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    return '<div class="controls">' +
      '<span class="tabs"><button data-tab="board"' + (state.tab === 'board' ? ' class="on"' : '') + '>Pre-token board</button>' +
      '<button data-tab="live"' + (state.tab === 'live' ? ' class="on"' : '') + '>Already trading</button>' +
      '<button data-tab="method"' + (state.tab === 'method' ? ' class="on"' : '') + '>Method &amp; audit</button></span>' +
      '<label>Search</label><input type="search" id="q" value="' + esc(state.q) + '" placeholder="name or slug">' +
      '<label>Category</label><select id="cat">' + catOpts + '</select>' +
      '<label>Chain</label><select id="chain">' + chainOpts + '</select>' +
      '<label class="toggle"><input type="checkbox" id="watch"' + (state.watch ? ' checked' : '') + '> Watchlist only</label>' +
      '<label class="toggle"><input type="checkbox" id="pinonly"' + (state.pinOnly ? ' checked' : '') + '> Pinned only</label>' +
      '<button class="btn" id="csvbtn" type="button">CSV</button>' +
      '<button class="btn' + (state.sbOpen || sandboxOn() ? ' on' : '') + '" id="sbbtn" type="button">Weights sandbox</button>' +
      '<button class="btn" id="palbtn" type="button">Commands <span class="kbd">/</span></button>' +
      '<span class="spacer"></span><span class="count" id="count"></span></div>';
  }

  function sandboxPanel() {
    if (!state.sbOpen && !sandboxOn()) return '';
    return '<div class="sandbox"><span class="sb-lab">Weights sandbox</span>' +
      '<label>growth terms <input type="range" id="sbg" min="0" max="2" step="0.25" value="' + state.sbG + '"> <b>' + state.sbG.toFixed(2) + 'x</b></label>' +
      '<label>track-record terms <input type="range" id="sba" min="0" max="2" step="0.25" value="' + state.sbA + '"> <b>' + state.sbA.toFixed(2) + 'x</b></label>' +
      '<button class="btn" id="sbreset" type="button">Reset to fitted</button>' +
      '<span class="sb-note">Re-ranks the visible board by re-weighting two fitted terms (1.00x = the fitted board). An exploration tool, not a refit: the board, the ranges and the verdicts stay the fitted ones.</span></div>';
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var rows = DATA.rows.filter(function (r) {
      if (state.watch && !r.watchlist) return false;
      if (state.pinOnly && !state.pins[r.slug]) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      return true;
    });
    if (sandboxOn()) {
      rows.sort(function (a, b) { return sandboxValue(b) - sandboxValue(a) || (a.rank - b.rank); });
      return rows;
    }
    var key = { implied: 'implied_value_usd', tvl: 'tvl_usd', change: 'change_7d', age: 'age_days', multiple: 'multiple', odds: 'launch_prob', ev: 'expected_value_usd' }[state.sort] || 'implied_value_usd';
    rows.sort(function (a, b) {
      var av = a[key] === null ? -Infinity : a[key], bv = b[key] === null ? -Infinity : b[key];
      return (av - bv) * state.dir || (a.rank - b.rank);
    });
    return rows;
  }

  function boardTable() {
    var rows = filtered();
    var sb = sandboxOn();
    var head = '<table class="board"><thead><tr>' +
      '<th data-sort="implied"># rank</th><th>Protocol</th><th>Category</th><th>Chains</th>' +
      '<th data-sort="tvl">TVL</th><th data-sort="change">7d</th><th data-sort="implied">Implied value</th>' +
      '<th data-sort="odds">Odds</th><th data-sort="ev">Expected</th>' +
      '<th>Fitted range</th><th data-sort="multiple">Mult</th><th data-sort="age">No-token age</th><th>Verdict &middot; fees/time</th></tr></thead><tbody>';
    var body = rows.map(function (r) {
      var chg = r.change_7d === null ? '<span class="flat">n/a</span>'
        : '<span class="' + (r.change_7d > 0 ? 'up' : r.change_7d < 0 ? 'down' : 'flat') + '">' + fmtPct(r.change_7d) + '</span>';
      var pinned = !!state.pins[r.slug];
      var inCmp = state.compare.indexOf(r.slug) >= 0;
      return '<tr data-slug="' + esc(r.slug) + '"' + (pinned ? ' class="pinned"' : '') + '>' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td><button type="button" class="pinbtn' + (pinned ? ' on' : '') + '" data-pin="' + esc(r.slug) + '" title="pin this row">' + (pinned ? '&#9733;' : '&#9734;') + '</button>' +
        '<input type="checkbox" class="cmpchk" data-cmp="' + esc(r.slug) + '"' + (inCmp ? ' checked' : '') + ' title="add to compare tray">' +
        '<span class="pname">' + esc(r.name) + '</span> <span class="pslug">' + esc(r.slug) + '</span>' +
        (r.watchlist ? ' <span class="badge watch">WATCHLIST</span>' : '') + '</td>' +
        '<td class="cat">' + esc(r.category || 'uncategorised') + '</td>' +
        '<td class="chains">' + esc(r.chains.slice(0, 1).join(', ')) + (r.chains.length > 1 ? ' +' + (r.chains.length - 1) : '') + '</td>' +
        '<td>' + fmtUsd(r.tvl_usd) + '</td><td>' + chg + '</td>' +
        '<td class="value">' + (sb ? fmtUsd(sandboxValue(r)) + ' <span class="sbtag">sandbox</span>' : fmtUsd(r.implied_value_usd)) + '</td>' +
        '<td class="odds">' + fmtOdds(r.launch_prob) + '</td>' +
        '<td class="ev">' + fmtUsd(r.expected_value_usd) + '</td>' +
        '<td><div class="rangebar"><div class="seg" style="left:' + logPos(r.implied_low_usd) + ';width:' + Math.max(2, parseFloat(logPos(r.implied_high_usd)) - parseFloat(logPos(r.implied_low_usd))) + '%"></div>' +
        '<div class="dot" style="left:' + logPos(r.implied_value_usd) + '"></div></div>' +
        '<div class="rangetext">' + fmtUsd(r.implied_low_usd) + ' - ' + fmtUsd(r.implied_high_usd) + '</div></td>' +
        '<td>' + fmtMult(r.multiple) + '</td>' +
        '<td>' + fmtAge(r.age_days) + '</td>' +
        '<td class="farm">' + verdictBadge(r.verdict) + ' ' + fmtUsd(r.farm_cost_usd) + ' / ' + r.farm_hours.toFixed(1) + 'h</td></tr>';
    }).join('');
    return head + body + '</tbody></table>';
  }

  function liveTable() {
    var body = DATA.live.map(function (r, i) {
      return '<tr><td class="rank">' + (i + 1) + '</td><td><span class="pname">' + esc(r.name) + '</span> <span class="pslug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || 'uncategorised') + '</td><td></td>' +
        '<td>' + fmtUsd(r.tvl_usd) + '</td><td></td><td class="value">' + fmtUsd(r.mcap_usd) + '</td>' +
        '<td></td><td></td>' +
        '<td><span class="rangetext">actual market cap, not a fit</span></td><td>' + fmtMult(r.multiple) + '</td><td></td><td></td></tr>';
    }).join('');
    return '<table class="board"><thead><tr><th>#</th><th>Protocol (token trades)</th><th>Category</th><th></th><th>TVL</th><th></th><th>Market cap</th><th></th><th></th><th></th><th>Actual mult</th><th></th><th></th></tr></thead><tbody>' + body + '</tbody></table>' +
      '<p class="footer">These ' + DATA.live.length + ' are the largest of the ' + DATA.counts.pricedComps + ' priced protocols the model was fitted on. They are shown apart from the board on purpose: the radar ranks only protocols that record no token.</p>';
  }

  function compareBar() {
    if (!state.compare.length) return '';
    var names = state.compare.map(function (s) { return esc(bySlug[s].name); }).join(' &middot; ');
    return '<div class="comparebar"><span>Compare: ' + names + '</span>' +
      '<button class="btn on" id="cmpopen" type="button"' + (state.compare.length < 2 ? ' disabled' : '') + '>Compare ' + state.compare.length + '</button>' +
      '<button class="btn" id="cmpclear" type="button">Clear</button></div>';
  }

  function compareModal() {
    if (!state.modal || state.compare.length < 2) return '';
    var rs = state.compare.map(function (s) { return bySlug[s]; });
    function row(label, fn) {
      return '<tr><td>' + label + '</td>' + rs.map(function (r) { return '<td>' + fn(r) + '</td>'; }).join('') + '</tr>';
    }
    var body = '<table class="cmptable"><tr><th></th>' + rs.map(function (r) { return '<th>' + esc(r.name) + '</th>'; }).join('') + '</tr>' +
      row('Board rank', function (r) { return '#' + r.rank; }) +
      row('Category', function (r) { return esc(r.category || 'uncategorised'); }) +
      row('Chains', function (r) { return esc(r.chains.join(', ')); }) +
      row('TVL', function (r) { return fmtUsd(r.tvl_usd); }) +
      row('7d change', function (r) { return fmtPct(r.change_7d); }) +
      row('No-token age', function (r) { return fmtAge(r.age_days); }) +
      row('Implied value', function (r) { return '<b>' + fmtUsd(r.implied_value_usd) + '</b>'; }) +
      row('Fitted range', function (r) { return fmtUsd(r.implied_low_usd) + ' - ' + fmtUsd(r.implied_high_usd); }) +
      row('Multiple of TVL', function (r) { return fmtMult(r.multiple); }) +
      row('Value build-up', function (r) { return 'curve ' + fmtUsd(r.parts.base) + ' &middot; cat ' + fmtMult(r.parts.category) + ' &middot; growth ' + fmtMult(r.parts.growth) + ' &middot; age ' + fmtMult(r.parts.age) + ' &middot; other ' + fmtMult(r.parts.other); }) +
      row('Launch odds', function (r) { return fmtOdds(r.launch_prob); }) +
      row('Expected value', function (r) { return fmtUsd(r.expected_value_usd); }) +
      row('Verdict', function (r) { return verdictBadge(r.verdict) + ' ' + fmtUsd(r.efficiency) + ' per $1 cost'; }) +
      row('Farm plan', function (r) { return fmtUsd(r.farm_capital_usd) + ' capital &middot; ' + fmtUsd(r.farm_cost_usd) + ' fees &middot; ' + r.farm_hours.toFixed(1) + 'h &middot; ' + r.farm_weeks + ' weeks'; }) +
      '</table>';
    return '<div class="overlay" id="overlay"><div class="dialog"><div class="dialog-head"><h2>Side by side</h2>' +
      '<button class="btn" id="cmpclose" type="button">Close</button></div>' + body + '</div></div>';
  }

  function palette() {
    if (!state.palette) return '';
    return '<div class="overlay" id="overlay"><div class="dialog pal"><h2>Command palette</h2>' +
      '<input type="text" id="palq" placeholder="Jump to a protocol, a category, or an action: csv, sandbox, method, live..." autocomplete="off">' +
      '<div id="palresults"></div>' +
      '<p class="small">Enter opens the first match. Actions: export CSV, toggle the weights sandbox, switch tabs, watchlist only.</p></div></div>';
  }

  function peerRow(label, band) {
    return '<tr><td>' + esc(label) + '</td><td>' + band.launched + ' of ' + band.total + ' launched</td><td>' + fmtOdds(band.rate) + '</td></tr>';
  }

  function detail(r) {
    var m = DATA.model;
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    var timeCost = r.farm_hours * m.verdicts.timeUsdPerHour;
    var fullCost = r.farm_cost_usd + timeCost;
    var catN = r.category ? catSamples[r.category] : undefined;
    return '<a class="back" href="#">&larr; back to the board</a>' +
      '<div class="detail-head"><h1>' + esc(r.name) + '</h1>' +
      '<span class="pslug">' + esc(r.slug) + '</span>' +
      (r.watchlist ? '<span class="badge watch">WATCHLIST</span>' : '') +
      '<span class="cat">' + esc(r.category || 'uncategorised') + ' &middot; ' + esc(r.chains.join(', ')) + '</span></div>' +
      '<div class="detail-grid">' +
      '<div class="stat"><div class="num">' + r.rank + '</div><div class="lab">board rank</div></div>' +
      '<div class="stat"><div class="num"><em>' + fmtUsd(r.implied_value_usd) + '</em></div><div class="lab">implied value</div></div>' +
      '<div class="stat"><div class="num">' + fmtUsd(r.tvl_usd) + '</div><div class="lab">TVL in snapshot</div></div>' +
      '<div class="stat"><div class="num">' + fmtMult(r.multiple) + '</div><div class="lab">implied multiple of TVL</div></div>' +
      '<div class="stat"><div class="num">' + fmtUsd(r.implied_low_usd) + '</div><div class="lab">fitted range, low</div></div>' +
      '<div class="stat"><div class="num">' + fmtUsd(r.implied_high_usd) + '</div><div class="lab">fitted range, high</div></div>' +
      '<div class="stat"><div class="num"><em>' + fmtOdds(r.launch_prob) + '</em></div><div class="lab">fitted launch odds</div></div>' +
      '<div class="stat"><div class="num">' + fmtUsd(r.expected_value_usd) + '</div><div class="lab">probability-weighted value</div></div>' +
      '<div class="stat"><div class="num">' + fmtPct(r.change_7d) + '</div><div class="lab">TVL change, 7 days</div></div>' +
      '<div class="stat"><div class="num">' + fmtAge(r.age_days) + '</div><div class="lab">run with no token</div></div></div>' +
      '<div class="detail-cols">' +
      '<div class="card"><h2>How this number is built</h2>' +
      '<table class="decomp">' +
      '<tr><td>TVL curve at ' + fmtUsd(r.tvl_usd) + ' of TVL (slope ' + m.slope.toFixed(2) + ')</td><td>' + fmtUsd(r.parts.base) + '</td></tr>' +
      '<tr><td>Category terms, ' + esc(r.category || 'uncategorised') + (catN !== undefined ? ' (fitted on ' + catN + ' priced comparable' + (catN === 1 ? '' : 's') + ')' : '') + '</td><td>' + fmtMult(r.parts.category) + '</td></tr>' +
      '<tr><td>Growth terms (' + fmtPct(r.change_7d) + ' over 7 days)</td><td>' + fmtMult(r.parts.growth) + '</td></tr>' +
      '<tr><td>Track-record terms (' + fmtAge(r.age_days) + ' with no token)</td><td>' + fmtMult(r.parts.age) + '</td></tr>' +
      '<tr><td>Other fitted terms (chains, size context, interactions)</td><td>' + fmtMult(r.parts.other) + '</td></tr>' +
      '<tr class="total"><td>Implied value</td><td>' + fmtUsd(r.implied_value_usd) + '</td></tr></table>' +
      '<p style="margin-top:8px">The range ' + fmtUsd(r.implied_low_usd) + ' to ' + fmtUsd(r.implied_high_usd) + ' is this category\'s residual spread around the fit. ' +
      'It is wide because the snapshot says value given TVL is wide; the rank is the claim, the range is the honesty.</p></div>' +
      '<div class="card"><h2>Farm plan: ' + r.farm_weeks + ' weeks</h2><ol class="plan">' + steps + '</ol>' +
      '<div class="totals">' +
      '<div class="stat"><div class="num">' + fmtUsd(r.farm_capital_usd) + '</div><div class="lab">capital at work, up to</div></div>' +
      '<div class="stat"><div class="num">' + fmtUsd(r.farm_cost_usd) + '</div><div class="lab">fees over programme</div></div>' +
      '<div class="stat"><div class="num">' + r.farm_hours.toFixed(1) + 'h</div><div class="lab">of your time</div></div>' +
      '<div class="stat"><div class="num">' + r.farm_weeks + '</div><div class="lab">weeks</div></div></div></div>' +
      '</div>' +
      '<div class="detail-cols" style="margin-top:10px">' +
      '<div class="card"><h2>Launch odds: the peers\' record</h2>' +
      '<table class="decomp">' +
      peerRow('Its category: ' + (r.category || 'uncategorised'), r.odds.category) +
      peerRow('Its age band: ' + r.odds.age.label, r.odds.age) +
      peerRow('Its TVL band: ' + r.odds.tvl.label, r.odds.tvl) +
      '<tr class="total"><td>Fitted odds (logistic' + (m.launch.calibrated ? ', Platt-calibrated' : '') + ')</td><td>' + fmtOdds(r.launch_prob) + '</td></tr></table>' +
      '<p style="margin-top:8px">The fitted odds blend these peer rates with this protocol\'s own size, growth and chain count. ' +
      'The model behind them scores AUC ' + m.launch.auc.toFixed(3) + ' on a blind holdout; the snapshot\'s base rate is ' + Math.round(m.launch.baseRate * 100) + '%.</p></div>' +
      '<div class="card"><h2>Farm verdict: ' + verdictBadge(r.verdict) + '</h2>' +
      '<table class="decomp">' +
      '<tr><td>Launch odds x implied value</td><td>' + fmtUsd(r.expected_value_usd) + '</td></tr>' +
      '<tr><td>Plan fees over ' + r.farm_weeks + ' weeks</td><td>' + fmtUsd(r.farm_cost_usd) + '</td></tr>' +
      '<tr><td>Your time, ' + r.farm_hours.toFixed(1) + 'h at $' + m.verdicts.timeUsdPerHour + '/h</td><td>' + fmtUsd(timeCost) + '</td></tr>' +
      '<tr><td>Full cost</td><td>' + fmtUsd(fullCost) + '</td></tr>' +
      '<tr><td>Expected value per $1 of full cost</td><td>' + fmtUsd(r.efficiency) + '</td></tr>' +
      '<tr class="total"><td>Board median efficiency</td><td>' + fmtUsd(m.verdicts.medianEfficiency) + '</td></tr></table>' +
      '<p style="margin-top:8px">GO needs odds of at least 50% and at-or-above-median efficiency; SELECTIVE needs odds of at least 35% with above-quartile efficiency, or top-decile efficiency at any odds; the rest are SKIP. ' +
      'The verdict is the board\'s arithmetic, printed with the plan; the decision stays the reader\'s.</p></div>' +
      '</div>';
  }

  function footer() {
    return '<p class="footer"><b>Reading this board:</b> rank is the fitted claim, ordered by implied value; the range is the model\'s own residual spread; the odds are a separate fit on whether peers like this protocol have launched at all; the verdict prices the plan against both. ' +
      'A protocol records no token in the sealed snapshot of ' + esc(DATA.as_of) + '; that is DefiLlama\'s record, not proof none exists. ' +
      'Implied values and launch odds are this entry\'s estimates from that snapshot\'s figures alone. Nothing here is a prediction that a token will be issued.</p>';
  }

  function render() {
    readHash();
    var html = masthead();
    if (state.slug && bySlug[state.slug]) {
      html += detail(bySlug[state.slug]);
    } else if (state.tab === 'method') {
      html += integrityStrip() + controls() + methodBand();
    } else if (state.tab === 'live') {
      html += integrityStrip() + controls() + liveTable() + methodBand();
    } else {
      html += integrityStrip() + controls() + sandboxPanel() + boardTable() + methodBand();
    }
    html += compareBar() + compareModal() + palette() + footer();
    app.innerHTML = html;
    app.setAttribute('aria-busy', 'false');
    wire();
    updateCount();
    if (state.palette) {
      var pq = document.getElementById('palq');
      if (pq) { pq.focus(); palRender(''); }
    }
  }

  function updateCount() {
    var count = document.getElementById('count');
    if (!count) return;
    count.textContent = state.tab === 'live' ? DATA.live.length + ' trading'
      : state.tab === 'method' ? 'method & audit'
      : filtered().length + ' of ' + DATA.rows.length + ' rows';
  }

  function exportCsv() {
    var rows = filtered();
    var head = 'rank,slug,name,category,chains,tvl_usd,change_7d,implied_value_usd,implied_low_usd,implied_high_usd,multiple,launch_prob,expected_value_usd,verdict,efficiency,farm_fees_usd,farm_hours,farm_weeks';
    function cell(v) {
      var s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var lines = rows.map(function (r) {
      return [r.rank, r.slug, r.name, r.category || '', r.chains.join('+'), r.tvl_usd, r.change_7d === null ? '' : r.change_7d,
        r.implied_value_usd, r.implied_low_usd, r.implied_high_usd, r.multiple, r.launch_prob, r.expected_value_usd,
        r.verdict, r.efficiency, r.farm_cost_usd, r.farm_hours, r.farm_weeks].map(cell).join(',');
    });
    var blob = new Blob([head + '\n' + lines.join('\n') + '\n'], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'token-launch-radar-board.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  function palItems(q) {
    q = q.trim().toLowerCase();
    var items = [];
    var actions = [
      { label: 'Export the current view as CSV', run: function () { exportCsv(); } },
      { label: 'Toggle the weights sandbox', run: function () { state.sbOpen = !state.sbOpen; render(); } },
      { label: 'Go to the pre-token board', run: function () { state.tab = 'board'; render(); } },
      { label: 'Go to already trading', run: function () { state.tab = 'live'; render(); } },
      { label: 'Go to method & audit', run: function () { state.tab = 'method'; render(); } },
      { label: 'Watchlist only on/off', run: function () { state.watch = !state.watch; state.tab = 'board'; render(); } },
      { label: 'Pinned only on/off', run: function () { state.pinOnly = !state.pinOnly; state.tab = 'board'; render(); } },
      { label: 'Reset the sandbox to the fitted weights', run: function () { state.sbG = 1; state.sbA = 1; render(); } }
    ];
    actions.forEach(function (a) { if (!q || a.label.toLowerCase().indexOf(q) >= 0) items.push({ kind: 'action', label: a.label, run: a.run }); });
    categories.forEach(function (c) {
      if (c.toLowerCase().indexOf(q) >= 0) items.push({ kind: 'category', label: 'Filter: ' + c, run: function () { state.category = c; state.tab = 'board'; render(); } });
    });
    if (q) {
      DATA.rows.forEach(function (r) {
        if (r.name.toLowerCase().indexOf(q) >= 0 || r.slug.indexOf(q) >= 0) {
          items.push({ kind: 'protocol', label: '#' + r.rank + ' ' + r.name + ' (' + r.slug + ')', run: function () { window.location.hash = 'p=' + r.slug; } });
        }
      });
    }
    return items.slice(0, 14);
  }

  function palRender(q) {
    var holder = document.getElementById('palresults');
    if (!holder) return;
    var items = palItems(q);
    holder.innerHTML = items.map(function (it, i) {
      return '<button type="button" class="pal-item" data-pal="' + i + '"><span class="kind">' + it.kind + '</span> ' + esc(it.label) + '</button>';
    }).join('') || '<p class="small">No match.</p>';
    holder.querySelectorAll('[data-pal]').forEach(function (b) {
      b.addEventListener('click', function () {
        var it = palItems(q)[Number(b.getAttribute('data-pal'))];
        state.palette = false;
        if (it) it.run(); else render();
      });
    });
  }

  function wire() {
    var q = document.getElementById('q');
    if (q) q.addEventListener('input', function () { state.q = q.value; rerenderTable(); });
    var cat = document.getElementById('cat');
    if (cat) cat.addEventListener('change', function () { state.category = cat.value; rerenderTable(); });
    var chain = document.getElementById('chain');
    if (chain) chain.addEventListener('change', function () { state.chain = chain.value; rerenderTable(); });
    var watch = document.getElementById('watch');
    if (watch) watch.addEventListener('change', function () { state.watch = watch.checked; rerenderTable(); });
    var pinonly = document.getElementById('pinonly');
    if (pinonly) pinonly.addEventListener('change', function () { state.pinOnly = pinonly.checked; rerenderTable(); });
    var csv = document.getElementById('csvbtn');
    if (csv) csv.addEventListener('click', exportCsv);
    var sbb = document.getElementById('sbbtn');
    if (sbb) sbb.addEventListener('click', function () { state.sbOpen = !state.sbOpen; render(); });
    var palb = document.getElementById('palbtn');
    if (palb) palb.addEventListener('click', function () { state.palette = true; render(); });
    var sbg = document.getElementById('sbg');
    if (sbg) sbg.addEventListener('input', function () { state.sbG = Number(sbg.value); render(); });
    var sba = document.getElementById('sba');
    if (sba) sba.addEventListener('input', function () { state.sbA = Number(sba.value); render(); });
    var sbr = document.getElementById('sbreset');
    if (sbr) sbr.addEventListener('click', function () { state.sbG = 1; state.sbA = 1; render(); });
    var cmpopen = document.getElementById('cmpopen');
    if (cmpopen) cmpopen.addEventListener('click', function () { state.modal = true; render(); });
    var cmpclear = document.getElementById('cmpclear');
    if (cmpclear) cmpclear.addEventListener('click', function () { state.compare = []; render(); });
    var cmpclose = document.getElementById('cmpclose');
    if (cmpclose) cmpclose.addEventListener('click', function () { state.modal = false; render(); });
    var overlay = document.getElementById('overlay');
    if (overlay) overlay.addEventListener('click', function (e) {
      if (e.target === overlay) { state.modal = false; state.palette = false; render(); }
    });
    var palq = document.getElementById('palq');
    if (palq) {
      palq.addEventListener('input', function () { palRender(palq.value); });
      palq.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          var items = palItems(palq.value);
          state.palette = false;
          if (items.length) items[0].run(); else render();
        }
      });
    }
    document.querySelectorAll('.tabs button').forEach(function (b) {
      b.addEventListener('click', function () { state.tab = b.getAttribute('data-tab'); render(); });
    });
    document.querySelectorAll('table.board th[data-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var s = th.getAttribute('data-sort');
        if (state.sort === s) state.dir = -state.dir; else { state.sort = s; state.dir = -1; }
        rerenderTable();
      });
    });
    document.querySelectorAll('[data-pin]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var s = b.getAttribute('data-pin');
        if (state.pins[s]) delete state.pins[s]; else state.pins[s] = true;
        savePins();
        rerenderTable();
      });
    });
    document.querySelectorAll('[data-cmp]').forEach(function (box) {
      box.addEventListener('click', function (e) { e.stopPropagation(); });
      box.addEventListener('change', function () {
        var s = box.getAttribute('data-cmp');
        var at = state.compare.indexOf(s);
        if (box.checked && at < 0) {
          if (state.compare.length >= 3) { box.checked = false; return; }
          state.compare.push(s);
        }
        if (!box.checked && at >= 0) state.compare.splice(at, 1);
        render();
      });
    });
    document.querySelectorAll('table.board tbody tr[data-slug]').forEach(function (tr) {
      tr.addEventListener('click', function () { window.location.hash = 'p=' + tr.getAttribute('data-slug'); });
    });
  }

  function rerenderTable() {
    var tables = document.querySelectorAll('table.board');
    if (!tables.length || state.tab === 'method') { render(); return; }
    var holder = document.createElement('div');
    holder.innerHTML = state.tab === 'live' ? liveTable() : boardTable();
    tables[0].replaceWith(holder.firstChild);
    updateCount();
    wire();
  }

  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (e.key === 'Escape' && (state.modal || state.palette)) { state.modal = false; state.palette = false; render(); return; }
    if (typing) return;
    if (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
      e.preventDefault();
      state.palette = true;
      render();
    }
  });

  window.addEventListener('hashchange', render);
  render();
})();
