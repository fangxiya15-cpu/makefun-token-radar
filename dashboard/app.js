// Token Launch Radar: the page. Reads window.RADAR (written beside this
// folder by main.ts from the same fitted model that wrote board.json) and
// renders the ranked board, a filterable table, a per-protocol detail view
// with the model's arithmetic for that row, and the already-trading
// reference set the model was fitted on. No network, no framework: every
// number on the page is in data.js, and the implied values are the board's.
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
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.round(days) + 'd';
  }
  function fmtMult(x) { return 'x' + Number(x).toFixed(3); }

  var state = { q: '', category: 'all', chain: 'all', watch: false, tab: 'board', sort: 'implied', dir: -1, slug: null };

  // Hash routing: #p=<slug> opens a detail view; #cat=, #chain=, #q=,
  // #watch=1 and #tab=live preset the board's filters (the screenshots are
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

  function masthead() {
    var c = DATA.counts;
    return '<div class="masthead"><div>' +
      '<h1>Token Launch <span class="radar">Radar</span></h1>' +
      '<p class="tagline">Pre-token protocols ranked by an implied value fitted on the snapshot itself: ' +
      'a log-log TVL curve plus per-category offsets over ' + c.pricedComps + ' protocols whose tokens already trade, ' +
      'adjusted for seven-day growth and for how long each protocol has run with no token. Every row carries the farm plan it would take to be positioned for a launch.</p></div>' +
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

  function methodBand() {
    var m = DATA.model;
    var cvRows = m.cv.map(function (row, i) {
      return '<tr' + (i === 1 ? ' class="here"' : '') + '><td>' + esc(row.variant) + '</td><td>' + row.medianFactor.toFixed(2) + 'x</td><td>' + row.within2xPct + '%</td><td>' + row.within4xPct + '%</td></tr>';
    }).join('');
    var chips = m.categories.slice(0, 14).map(function (c) {
      return '<span class="chip">' + esc(c.category) + ' <b>' + fmtMult(c.multiple) + '</b> (n=' + c.samples + ')</span>';
    }).join('');
    return '<div class="method">' +
      '<div class="card"><h2>How each implied value is fitted</h2>' +
      '<p>The board never ranks by name. Over the <b>' + m.samples + ' protocols whose token already trades at a measurable cap</b>, the model fits ' +
      '<b>log(market cap) = ' + m.intercept.toFixed(2) + ' + ' + m.slope.toFixed(2) + ' x log(TVL)</b>, then shifts each category by its median residual ' +
      '(shrunk by n/(n+4), so thin categories barely move it). Two terms fitted on the residuals follow: <b>seven-day TVL growth</b> at ' +
      (m.growthCoefPerPct >= 0 ? '+' : '') + (m.growthCoefPerPct * 100).toFixed(2) + '% of value per +1% of growth, and <b>years run with no token</b> at ' +
      (m.ageCoefPerYear >= 0 ? '+' : '') + (m.ageCoefPerYear * 100).toFixed(1) + '% per year; both are applied at ' + Math.round(m.shrink * 100) + '% of fitted strength, ' +
      'because the cross-validation at right shows full strength overfits. Protocols that record a token with no measurable cap (' + DATA.counts.unpricedListed + ') are excluded from the fit and from the board.</p>' +
      '<p>The range on each row is the fitted value shifted by the residual quartiles (' + m.residQ25.toFixed(2) + ' to +' + m.residQ75.toFixed(2) + ' in log space): ' +
      'given TVL alone, value is honestly a range of about a factor of ' + Math.exp(m.residQ75 - m.residQ25).toFixed(1) + ', and the board says so instead of faking a point.</p>' +
      '<p><b>Who is ranked:</b> of ' + DATA.counts.protocols + ' protocols, ' + DATA.counts.preToken + ' record no token. The board ranks the ' + DATA.counts.eligible + ' that pass the same product tests the snapshot\'s own watchlist uses, at every size rather than only above the $50M floor: ' +
      'not an exchange (' + DATA.excluded.cex + ' set aside), not a canonical bridge (' + DATA.excluded.canonicalBridge + '), not a versioned pool or a wrapped/staked product by name (' + DATA.excluded.versionedOrWrappedName + '), ' +
      'not an exchange-branded product (' + DATA.excluded.exchangeName + '), and not a one-chain bridge, which is a wrapped asset rather than a bridge (' + DATA.excluded.oneChainBridge + '). Every one of the ' + DATA.counts.watchlist + ' watchlist protocols passes and is ranked.</p>' +
      '<div class="chips">' + chips + '</div></div>' +
      '<div class="card"><h2>Cross-validation on the snapshot (3 folds)</h2>' +
      '<table><tr><th>model variant</th><th>median error</th><th>within 2x</th><th>within 4x</th></tr>' + cvRows + '</table>' +
      '<p style="margin-top:7px">Fitted on two folds, scored on the held-out third, rotated. The middle row is the model this board uses.</p></div>' +
      '</div>';
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
      '<button data-tab="live"' + (state.tab === 'live' ? ' class="on"' : '') + '>Already trading</button></span>' +
      '<label>Search</label><input type="search" id="q" value="' + esc(state.q) + '" placeholder="name or slug">' +
      '<label>Category</label><select id="cat">' + catOpts + '</select>' +
      '<label>Chain</label><select id="chain">' + chainOpts + '</select>' +
      '<label class="toggle"><input type="checkbox" id="watch"' + (state.watch ? ' checked' : '') + '> Watchlist only</label>' +
      '<span class="spacer"></span><span class="count" id="count"></span></div>';
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var rows = DATA.rows.filter(function (r) {
      if (state.watch && !r.watchlist) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      return true;
    });
    var key = { implied: 'implied_value_usd', tvl: 'tvl_usd', change: 'change_7d', age: 'age_days', multiple: 'multiple' }[state.sort] || 'implied_value_usd';
    rows.sort(function (a, b) {
      var av = a[key] === null ? -Infinity : a[key], bv = b[key] === null ? -Infinity : b[key];
      return (av - bv) * state.dir || (a.rank - b.rank);
    });
    return rows;
  }

  function boardTable() {
    var rows = filtered();
    var head = '<table class="board"><thead><tr>' +
      '<th data-sort="implied"># rank</th><th>Protocol</th><th>Category</th><th>Chains</th>' +
      '<th data-sort="tvl">TVL</th><th data-sort="change">7d</th><th data-sort="implied">Implied value</th>' +
      '<th>Fitted range</th><th data-sort="multiple">Mult</th><th data-sort="age">No-token age</th><th>Farm: fees / time</th></tr></thead><tbody>';
    var body = rows.map(function (r) {
      var chg = r.change_7d === null ? '<span class="flat">n/a</span>'
        : '<span class="' + (r.change_7d > 0 ? 'up' : r.change_7d < 0 ? 'down' : 'flat') + '">' + fmtPct(r.change_7d) + '</span>';
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span> <span class="pslug">' + esc(r.slug) + '</span>' +
        (r.watchlist ? ' <span class="badge watch">WATCHLIST</span>' : '') + '</td>' +
        '<td class="cat">' + esc(r.category || 'uncategorised') + '</td>' +
        '<td class="chains">' + esc(r.chains.slice(0, 2).join(', ')) + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') + '</td>' +
        '<td>' + fmtUsd(r.tvl_usd) + '</td><td>' + chg + '</td>' +
        '<td class="value">' + fmtUsd(r.implied_value_usd) + '</td>' +
        '<td><div class="rangebar"><div class="seg" style="left:' + logPos(r.implied_low_usd) + ';width:' + Math.max(2, parseFloat(logPos(r.implied_high_usd)) - parseFloat(logPos(r.implied_low_usd))) + '%"></div>' +
        '<div class="dot" style="left:' + logPos(r.implied_value_usd) + '"></div></div>' +
        '<div class="rangetext">' + fmtUsd(r.implied_low_usd) + ' - ' + fmtUsd(r.implied_high_usd) + '</div></td>' +
        '<td>' + fmtMult(r.multiple) + '</td>' +
        '<td>' + fmtAge(r.age_days) + '</td>' +
        '<td class="farm">' + fmtUsd(r.farm_cost_usd) + ' / ' + r.farm_hours.toFixed(1) + 'h</td></tr>';
    }).join('');
    return head + body + '</tbody></table>';
  }

  function liveTable() {
    var body = DATA.live.map(function (r, i) {
      return '<tr><td class="rank">' + (i + 1) + '</td><td><span class="pname">' + esc(r.name) + '</span> <span class="pslug">' + esc(r.slug) + '</span></td>' +
        '<td class="cat">' + esc(r.category || 'uncategorised') + '</td><td></td>' +
        '<td>' + fmtUsd(r.tvl_usd) + '</td><td></td><td class="value">' + fmtUsd(r.mcap_usd) + '</td>' +
        '<td><span class="rangetext">actual market cap, not a fit</span></td><td>' + fmtMult(r.multiple) + '</td><td></td><td></td></tr>';
    }).join('');
    return '<table class="board"><thead><tr><th>#</th><th>Protocol (token trades)</th><th>Category</th><th></th><th>TVL</th><th></th><th>Market cap</th><th></th><th>Actual mult</th><th></th><th></th></tr></thead><tbody>' + body + '</tbody></table>' +
      '<p class="footer">These ' + DATA.live.length + ' are the largest of the ' + DATA.counts.pricedComps + ' priced protocols the model was fitted on. They are shown apart from the board on purpose: the radar ranks only protocols that record no token.</p>';
  }

  function detail(r) {
    var m = DATA.model;
    var steps = r.farm_steps.map(function (s, i) { return '<li>' + esc(s) + '</li>'; }).join('');
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
      '<div class="stat"><div class="num">' + fmtPct(r.change_7d) + '</div><div class="lab">TVL change, 7 days</div></div>' +
      '<div class="stat"><div class="num">' + fmtAge(r.age_days) + '</div><div class="lab">run with no token</div></div></div>' +
      '<div class="detail-cols">' +
      '<div class="card"><h2>How this number is built</h2>' +
      '<table class="decomp">' +
      '<tr><td>TVL curve at ' + fmtUsd(r.tvl_usd) + ' of TVL (slope ' + m.slope.toFixed(2) + ')</td><td>' + fmtUsd(r.parts.base) + '</td></tr>' +
      '<tr><td>Category offset, ' + esc(r.category || 'uncategorised') + '</td><td>' + fmtMult(r.parts.category) + '</td></tr>' +
      '<tr><td>Seven-day growth term (' + fmtPct(r.change_7d) + ')</td><td>' + fmtMult(r.parts.growth) + '</td></tr>' +
      '<tr><td>Track-record term (' + fmtAge(r.age_days) + ' with no token)</td><td>' + fmtMult(r.parts.age) + '</td></tr>' +
      '<tr class="total"><td>Implied value</td><td>' + fmtUsd(r.implied_value_usd) + '</td></tr></table>' +
      '<p style="margin-top:8px">The range ' + fmtUsd(r.implied_low_usd) + ' to ' + fmtUsd(r.implied_high_usd) + ' is this category\'s residual spread around the fit. ' +
      'It is wide because the snapshot says value given TVL is wide; the rank is the claim, the range is the honesty.</p></div>' +
      '<div class="card"><h2>Farm plan: ' + r.farm_weeks + ' weeks</h2><ol class="plan">' + steps + '</ol>' +
      '<div class="totals">' +
      '<div class="stat"><div class="num">' + fmtUsd(r.farm_capital_usd) + '</div><div class="lab">capital at work, up to</div></div>' +
      '<div class="stat"><div class="num">' + fmtUsd(r.farm_cost_usd) + '</div><div class="lab">fees over programme</div></div>' +
      '<div class="stat"><div class="num">' + r.farm_hours.toFixed(1) + 'h</div><div class="lab">of your time</div></div>' +
      '<div class="stat"><div class="num">' + r.farm_weeks + '</div><div class="lab">weeks</div></div></div></div>' +
      '</div>';
  }

  function footer() {
    return '<p class="footer"><b>Reading this board:</b> rank is the fitted claim, ordered by implied value; the range is the model\'s own residual spread. ' +
      'A protocol records no token in the sealed snapshot of ' + esc(DATA.as_of) + '; that is DefiLlama\'s record, not proof none exists. ' +
      'Implied values are this entry\'s estimates from that snapshot\'s figures alone. Nothing here is a prediction that a token will be issued.</p>';
  }

  function render() {
    readHash();
    var html = masthead();
    if (state.slug && bySlug[state.slug]) {
      html += detail(bySlug[state.slug]);
    } else if (state.tab === 'live') {
      html += methodBand() + controls() + liveTable();
    } else {
      html += methodBand() + controls() + boardTable();
    }
    html += footer();
    app.innerHTML = html;
    app.setAttribute('aria-busy', 'false');
    wire();
    var count = document.getElementById('count');
    if (count) count.textContent = state.tab === 'live' ? DATA.live.length + ' trading' : filtered().length + ' of ' + DATA.rows.length + ' rows';
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
    document.querySelectorAll('table.board tbody tr[data-slug]').forEach(function (tr) {
      tr.addEventListener('click', function () { window.location.hash = 'p=' + tr.getAttribute('data-slug'); });
    });
  }

  function rerenderTable() {
    var tables = document.querySelectorAll('table.board');
    if (!tables.length) { render(); return; }
    var holder = document.createElement('div');
    holder.innerHTML = state.tab === 'live' ? liveTable() : boardTable();
    tables[0].replaceWith(holder.firstChild);
    var count = document.getElementById('count');
    if (count) count.textContent = state.tab === 'live' ? DATA.live.length + ' trading' : filtered().length + ' of ' + DATA.rows.length + ' rows';
    wire();
  }

  window.addEventListener('hashchange', render);
  render();
})();
