/* eslint-disable no-useless-escape --
 * This file embeds a real browser <script> (regex literals, CSS, etc.)
 * verbatim inside TS template-literal constants. ESLint parses that
 * content as plain TS string data and flags escapes like \/ (regex
 * delimiter) and \- (char-class hyphen) as "useless" -- they are NOT
 * useless: they are load-bearing escapes required by the actual browser
 * JS that runs once this string becomes analytics.html again. Auto-fixing
 * them would corrupt that runtime JS (e.g. turning the CSV-injection
 * guard's [=+\-@] into the char-class range [=+-@], or breaking the
 * safeProfileLink URL-scheme regex into a JS comment -- see the incident
 * note below). Do not accept an autofix for this rule in this file.
 */
/**
 * Static HTML/CSS/JS shell for the analytics dashboard.
 *
 * THIS FILE IS THE ONLY SOURCE OF TRUTH for the dashboard's markup,
 * styling, and client-side behavior. The dashboard route
 * (src/app/api/analytics/dashboard/route.ts) serves the ENTIRE shell via
 * buildAnalyticsHtml(), regenerated on every request from the current
 * getSearchRecords() data, so hand-editing any served HTML has no lasting
 * effect — the next request silently overwrites it with whatever this file
 * currently says. If you want to change the dashboard's look or behavior,
 * edit the HEAD/TAIL templates below, not a generated file.
 *
 * IMPORTANT -- how this file must be edited:
 * The content below is embedded as escaped template-literal string data,
 * not run directly as the browser script it represents. That distinction
 * bit us once already: a previous version of this file had
 * *single*-backslash regex escapes (e.g. \/\/, \-) that are correct in
 * a normal .js file but are NOT correct inside a TS template literal --
 * a lone backslash before a character with no special meaning (like / or
 * -) is silently DROPPED by the template-literal parser. That turned
 * safeProfileLink's URL-scheme check (/^https?:\/\//i) into
 * /^https?:///i, which -- once written into the real <script> tag and
 * parsed by a browser -- splits into the regex /^https?:/ followed by a
 * `//` comment that swallows the rest of the line, making
 * isSafe always true and silently reintroducing the XSS bug.
 * The csvSafeCell guar was hit the same way ([=+\-@]
 * became the char-class range [=+-@]).
 *
 * DO NOT hand-edit HEAD/TAIL by pasting new JS in and manually doubling
 * backslashes -- it's exactly how the bug above happened. Instead:
 *   1. Edit the dashboard's actual <script>/CSS/HTML somewhere you can
 *      run it directly (e.g. a scratch .html file, or analytics.html
 *      itself as a *scratch pad*, knowing the next real write ignores it).
 *   2. Regenerate HEAD/TAIL from that verified-working source
 *      programmatically (split on the <script id="db"> markers, then
 *      JSON.stringify() -- or an escaper that handles backslash/backtick/
 *      ${{}} -- rather than hand-typing escapes).
 *   3. Confirm by actually requiring/evaluating the resulting file and
 *      diffing the runtime string against the source you started from --
 *      not just eyeballing it -- before committing.
 *
 * Split in three around the data blocks: HEAD ends right after the
 * `<script id="db">` opening tag, the entries array follows, then WATCH_MID
 * closes it and opens `<script id="watch-db">`, then the watch JSON, then
 * TAIL (which starts at the watch block's closing tag).
 * buildAnalyticsHtml() joins the parts around the two serialized payloads.
 */

export const ANALYTICS_DASHBOARD_HEAD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Steam Friend Finder — Analytics</title>
<style>
  :root {
    --bg: #0f1115;
    --panel: #171a21;
    --border: #2a2e37;
    --text: #e6e8eb;
    --muted: #8b93a1;
    --accent: #4fa3ff;
    --accent2: #7ee0c3;
    --accent3: #ffb454;
    --accent4: #ff6b9e;
    --accent5: #a78bfa;
    --danger: #ff6b6b;
    --safe: #7ee081;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .subtitle { color: var(--muted); font-size: 13px; margin-bottom: 24px; }

  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px;
    margin-bottom: 24px;
  }
  .stat-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
  }
  .stat-card .value { font-size: 22px; font-weight: 600; }
  .stat-card .label { font-size: 12px; color: var(--muted); margin-top: 2px; }

  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 24px;
  }
  .panel h2 {
    font-size: 14px;
    margin: 0 0 4px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .panel .panel-note { font-size: 11px; color: var(--muted); margin: 0 0 12px; }

  .charts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }
  .charts-grid .panel { margin-bottom: 0; }

  .chart-with-legend { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }

  .legend { list-style: none; margin: 0; padding: 0; font-size: 12px; flex: 1 1 140px; min-width: 120px; }
  .legend li { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
  .legend .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; flex: none; }
  .legend .val { margin-left: auto; color: var(--muted); padding-left: 8px; }

  /* svgBarChart now renders the SVG at exactly the container size (1:1
     with the viewBox), so this width:100%/height:auto only acts as a
     visual safety net between a window resize and the next re-render
     (which happens debounced) — it keeps scaling uniform (no stretching
     X and Y differently) in that interval. */
  .bar-chart-svg { display: block; width: 100%; height: auto; }
  .bar-rect { cursor: pointer; transition: opacity 0.1s ease; }
  .bar-rect:hover { opacity: 0.8; }

  .chart-tooltip {
    position: fixed;
    display: none;
    pointer-events: none;
    z-index: 1000;
    background: #1c2029;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 12px;
    color: var(--text);
    white-space: nowrap;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
  }
  .chart-tooltip .tt-label { color: var(--muted); margin-right: 6px; }

  .bar-legend {
    list-style: none;
    margin: 10px 0 0;
    padding: 10px 0 0;
    border-top: 1px solid var(--border);
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
    font-size: 12px;
  }
  .bar-legend li { display: flex; align-items: center; gap: 6px; max-width: 100%; }
  .bar-legend .swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; display: inline-block; }
  .bar-legend-label { color: var(--text); }
  .bar-legend-value { color: var(--muted); }

  .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }

  input#filter {
    flex: 1 1 240px;
    padding: 8px 10px;
    background: #0f1115;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 13px;
  }

  button.btn {
    background: #1c2029;
    border: 1px solid var(--border);
    color: var(--text);
    padding: 8px 14px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
  }
  button.btn:hover { border-color: var(--accent); color: var(--accent); }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; white-space: nowrap; }
  tr:hover td { background: #1c2029; }

  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  .rank-list { list-style: none; margin: 0; padding: 0; }
  .rank-list li { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; gap: 8px; }
  .rank-list li:last-child { border-bottom: none; }
  .rank-list .count { color: var(--muted); white-space: nowrap; }

  .badge {
    display: inline-block;
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 999px;
    background: #1c2029;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .badge.risk-low { color: var(--safe); border-color: var(--safe); }
  .badge.risk-mid { color: var(--accent3); border-color: var(--accent3); }
  .badge.risk-high { color: var(--danger); border-color: var(--danger); }

  details summary { cursor: pointer; color: var(--accent); }
  details ul { margin: 8px 0 0; padding-left: 18px; }
  details li { margin-bottom: 4px; }

  .empty { color: var(--muted); font-size: 13px; padding: 12px 0; }
  .muted-small { color: var(--muted); font-size: 11px; }
</style>
</head>
<body>

<div class="chart-tooltip" id="chart-tooltip"></div>

<h1>Steam Friend Finder — Analytics</h1>
<div class="subtitle">Search history, profiles, friends and behavior signals</div>

<div class="stats" id="stats"></div>

<div class="charts-grid">
  <div class="panel">
    <h2>Searches per day</h2>
    <p class="panel-note">Last 30 days</p>
    <div id="chart-by-day"></div>
  </div>

  <div class="panel">
    <h2>Searches by hour of day</h2>
    <p class="panel-note">Local time of each search, all days combined</p>
    <div id="chart-by-hour"></div>
  </div>

  <div class="panel">
    <h2>Searcher language</h2>
    <p class="panel-note">Requester locale (next-intl)</p>
    <div id="chart-locale" class="chart-with-legend"></div>
  </div>

  <div class="panel">
    <h2>Browser language</h2>
    <p class="panel-note">Browser language (navigator.language)</p>
    <div id="chart-browser-lang" class="chart-with-legend"></div>
  </div>

  <div class="panel">
    <h2>Device</h2>
    <p class="panel-note">Mobile vs. desktop</p>
    <div id="chart-device" class="chart-with-legend"></div>
  </div>

  <div class="panel">
    <h2>Searcher countries</h2>
    <p class="panel-note">Top countries + "others"</p>
    <div id="chart-country"></div>
  </div>

  <div class="panel">
    <h2>Cheater probability</h2>
    <p class="panel-note">Computed reports per outcome band</p>
    <div id="chart-cheater"></div>
  </div>

  <div class="panel" style="grid-column: 1 / -1;">
    <h2>Most predicted target locations</h2>
    <p class="panel-note">#1 location guess (friend-based geolocation) per search</p>
    <div id="chart-locations"></div>
  </div>

  <div class="panel" style="grid-column: 1 / -1;">
    <h2>Most played games — Average per Searched Profile</h2>
    <p class="panel-note">Top 20 games: total game hours / total searched profiles (dilutes popularity)</p>
    <div id="chart-games-per-profile"></div>
  </div>

  <div class="panel" style="grid-column: 1 / -1;">
    <h2>Most played games — Engagement Average</h2>
    <p class="panel-note">Top 20 games: total game hours / number of profiles that played it (measures intensity)</p>
    <div id="chart-games-engagement"></div>
  </div>
</div>

<div class="charts-grid">
  <div class="panel">
    <h2>Active Counter-Strike</h2>
    <p class="panel-note">Profiles where CS has ≥300 hours OR is the most played game</p>
    <div id="chart-cs-active"></div>
  </div>

  <div class="panel">
    <h2>Most searched profiles</h2>
    <ul class="rank-list" id="top-profiles"></ul>
  </div>

  <div class="panel">
    <h2>Most frequent friends</h2>
    <ul class="rank-list" id="top-friends"></ul>
  </div>
</div>

<h1 style="margin-top: 8px;">Watch</h1>
<p class="subtitle">Opt-in Steam-profile monitoring: counts, locales, bot deliveries and current status (read from the watch tables — no extra writes)</p>

<div class="stats" id="watch-stats"></div>

<div class="charts-grid">
  <div class="panel">
    <h2>Signups per day</h2>
    <p class="panel-note">Watch accounts created, last 30 days</p>
    <div id="chart-watch-signups"></div>
  </div>

  <div class="panel">
    <h2>Watcher locales</h2>
    <p class="panel-note">Requester locale at signup (accounts — one row per user)</p>
    <div id="chart-watch-locales" class="chart-with-legend"></div>
  </div>

  <div class="panel">
    <h2>Bot deliveries per day</h2>
    <p class="panel-note">Sent events, all lanes combined, last 30 days</p>
    <div id="chart-watch-deliveries"></div>
  </div>

  <div class="panel">
    <h2>Delivery totals</h2>
    <p class="panel-note">Sent vs dropped, all time by lane</p>
    <ul class="rank-list" id="watch-delivery-totals"></ul>
  </div>
</div>

<div class="panel">
  <h2>Search history</h2>
  <div class="toolbar">
    <input id="filter" type="text" placeholder="Filter by nickname, SteamID, GC name, country, language..." />
    <button class="btn" id="export-csv">⬇ Export CSV</button>
  </div>
  <table id="searches-table">
    <thead>
      <tr>
        <th>Date</th>
        <th>Searched profile</th>
        <th>GC name</th>
        <th>Friends</th>
        <th>Predicted location</th>
        <th>Cheater</th>
        <th>Origin</th>
        <th>Duration</th>
      </tr>
    </thead>
    <tbody id="searches-body"></tbody>
  </table>
  <div class="empty" id="empty-msg" style="display:none;">No searches recorded yet.</div>
</div>

<!--
  This JSON block IS the "database". It is read and rewritten
  programmatically (see analytics.ts) — do not hand-edit
  unless you know what you are doing.

  New fields (requesterLocale, requesterCountry, device, locationGuess,
  cheater, durationMs, friends[].probability/mutualCount, etc.) are
  OPTIONAL. Old entries simply don't have them — that is expected,
  not an error, and all the code below treats that as "no data yet".

  The second block below (<script id="watch-db">, inserted by
  buildAnalyticsHtml between this block's closing tag and TAIL) carries
  the Watch aggregates (or null when those reads failed) — same rules.
-->
<script type="application/json" id="db">`;

export const ANALYTICS_DASHBOARD_TAIL = `</script>

<script>
(function () {
  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Only ever render profile.steamUrl (and similar user-controlled fields)
  // as a clickable <a href>. escapeHtml() alone does not stop a
  // "javascript:" / "data:" scheme from being stored and later clicked.
  // Ideally this would also be scoped to https://steamcommunity.com/, but
  // at minimum we require an http(s) scheme.
  function safeProfileLink(url, label) {
    var isSafe = typeof url === 'string' && /^https?:\\/\\//i.test(url);
    return isSafe
      ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + label + '</a>'
      : label;
  }

  // Steam nicknames (and GC names) are third-party-controlled strings.
  // Excel/Google Sheets treat a cell starting with =, +, -, or @ as a
  // formula, which is a known CSV-injection vector (e.g. a nickname like
  // "=cmd|'/c calc'!A0"). Prefixing such cells with a single quote forces
  // spreadsheet apps to treat them as literal text instead of evaluating
  // them. Applied to every cell in the CSV export, not just nickname/GC
  // name, since it's cheap and any field could theoretically start with
  // one of these characters.
  function csvSafeCell(value) {
    var s = String(value);
    return /^[=+\\-@]/.test(s) ? "'" + s : s;
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleString('pt-BR');
    } catch (e) {
      return iso;
    }
  }

  function dayKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // Flags are just Unicode regional-indicator pairs built from the 2-letter
  // ISO code, so this works for any country without a lookup table.
  function flagEmoji(cc) {
    if (!cc || typeof cc !== 'string' || cc.length !== 2) return '';
    var chars = cc.toUpperCase().split('').map(function (c) {
      return 127397 + c.charCodeAt(0);
    });
    try {
      return String.fromCodePoint.apply(null, chars);
    } catch (e) {
      return '';
    }
  }

  function riskBadge(score) {
    if (typeof score !== 'number') return '<span class="badge">—</span>';
    var cls = score >= 60 ? 'risk-high' : score >= 30 ? 'risk-mid' : 'risk-low';
    return '<span class="badge ' + cls + '">' + score.toFixed(0) + '%</span>';
  }

  // Normalizes a cheater score that may be either a fraction (0-1) or a percent (0-100)
  function normalizeScore(raw) {
    if (typeof raw !== 'number' || isNaN(raw)) return NaN;
    return raw <= 1 ? raw * 100 : raw;
  }

  // Formats a location which can be either a string or an object produced by
  // getCitiesNames() ({ cityName, stateName, countryName, countryCode }).
  function formatLocation(loc) {
    if (!loc) return '';
    if (typeof loc === 'string') return loc;
    var parts = [];
    if (loc.cityName) parts.push(loc.cityName);
    if (loc.stateName) parts.push(loc.stateName);
    if (loc.countryName) parts.push(loc.countryName);
    if (parts.length) return parts.join(', ');
    if (loc.countryCode) return loc.countryCode;
    return JSON.stringify(loc);
  }

  function topNPlusOthers(counts, n) {
    var arr = Object.keys(counts).map(function (k) { return { label: k, value: counts[k] }; });
    arr.sort(function (a, b) { return b.value - a.value; });
    if (arr.length <= n) return arr;
    var top = arr.slice(0, n);
    var restSum = arr.slice(n).reduce(function (s, d) { return s + d.value; }, 0);
    if (restSum > 0) top.push({ label: 'others', value: restSum });
    return top;
  }

  var PALETTE = ['#4fa3ff', '#7ee0c3', '#ffb454', '#ff6b9e', '#a78bfa', '#5cd6c0', '#e0c15c', '#8b93a1'];

  function debounce(fn, wait) {
    var timer;
    return function () {
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(null, args); }, wait);
    };
  }

  // Real width (in px) of the chart container. We used to hardcode width=700
  // and stretch the SVG to 100% with preserveAspectRatio="none" — that
  // scales X and Y by different factors whenever the panel isn't
  // exactly 700px (which in a responsive grid is practically never),
  // squeezing/stretching every glyph and leaving labels illegible.
  // Measuring the container and building the chart at that exact width
  // eliminates the distortion.
  function containerWidth(el, fallback) {
    var w = el && el.clientWidth;
    return w && w > 0 ? w : (fallback || 700);
  }

  // Estimated average glyph width in this font stack (~0.56em per
  // character) — enough to decide "does this label fit?" without truly
  // measuring via canvas.
  function estimateTextWidth(text, fontSize) {
    return String(text).length * fontSize * 0.56;
  }

  function truncateToWidth(text, fontSize, maxWidth) {
    var str = String(text);
    if (estimateTextWidth(str, fontSize) <= maxWidth) return str;
    var maxChars = Math.max(1, Math.floor(maxWidth / (fontSize * 0.56)) - 1);
    return str.slice(0, maxChars) + '…';
  }

  // ---- Minimal SVG bar chart (no external deps, matches the dark theme) ----
  // opts.width must be the real container width (see containerWidth
  // above), so the viewBox maps 1:1 to CSS pixels and nothing gets
  // distorted. Each bar also carries data-label/data-value for the popover
  // (see attachChartTooltip below) — the popover shows the exact value,
  // the axis text here is just orientation, so it can stay sparse.
  //
  // Axis labels are picked by real collision, not "every N bars": each one
  // is only drawn if it doesn't overlap the previous one (using the
  // estimated text width). The 90px minimum budget for truncation exists
  // so a short label like "unknown" or "20-30%" isn't cut just because
  // its bar is narrow — the unlabeled neighbor bar yields the space.
  //
  // opts.showLabels: false turns the axis text off entirely. Used in the
  // "Most predicted locations" chart, where the strings (city+state+country)
  // are too long to fit under any bar without turning into a mess
  // — there we use a legend underneath (see barLegendHtml) instead.
  function svgBarChart(data, opts) {
    opts = opts || {};
    var width = opts.width || 700;
    var showLabels = opts.showLabels !== false;
    var height = opts.height || (showLabels ? 190 : 160);
    var fontSize = opts.fontSize || 10;
    var padding = { top: 14, right: 6, bottom: showLabels ? 26 : 8, left: 6 };
    var innerW = width - padding.left - padding.right;
    var innerH = height - padding.top - padding.bottom;
    var max = Math.max.apply(null, data.map(function (d) { return d.value; }).concat([1]));
    var barGap = data.length > 20 ? 2 : 4;
    var barW = data.length ? Math.max(1, innerW / data.length - barGap) : 0;
    var slot = barW + barGap;

    if (!data.length || max === 0) {
      return '<div class="empty">Not enough data yet.</div>';
    }

    var lastLabelRight = -Infinity;
    var minGap = 6;

    var bars = data.map(function (d, i) {
      var barH = max ? (d.value / max) * innerH : 0;
      var x = padding.left + i * slot;
      var y = padding.top + (innerH - barH);
      var color = d.color || opts.color || 'var(--accent)';
      var cx = x + barW / 2;
      var rawLabel = String(d.label);

      var text = '';
      if (showLabels) {
        var labelBudget = Math.max(90, slot);
        var fitLabel = truncateToWidth(rawLabel, fontSize, labelBudget);
        var estWidth = estimateTextWidth(fitLabel, fontSize);
        var labelLeft = cx - estWidth / 2;
        if (barW > 4 && labelLeft >= 0 && cx + estWidth / 2 <= width && labelLeft > lastLabelRight + minGap) {
          text = '<text x="' + cx.toFixed(1) + '" y="' + (height - 8) + '" font-size="' + fontSize + '" fill="var(--muted)" text-anchor="middle">' + escapeHtml(fitLabel) + '</text>';
          lastLabelRight = cx + estWidth / 2;
        }
      }

      return '<rect class="bar-rect" data-label="' + escapeHtml(rawLabel) + '" data-value="' + escapeHtml(String(d.value)) +
        '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + Math.max(barH, 1).toFixed(1) +
        '" fill="' + color + '" rx="2"></rect>' + text;
    }).join('');

    return '<svg class="bar-chart-svg" viewBox="0 0 ' + width + ' ' + height + '" width="' + width + '" height="' + height + '">' + bars + '</svg>';
  }

  // Legend below the chart (swatch + full name + value), for
  // categories whose text is too long to fit on an axis (e.g. predicted
  // locations). Reuses the same layout as the other charts' axis text:
  // never truncates, never overlaps, only wraps.
  function barLegendHtml(data) {
    if (!data.length) return '';
    return '<ul class="bar-legend">' + data.map(function (d) {
      return '<li><span class="swatch" style="background:' + (d.color || 'var(--accent)') + ';"></span>' +
        '<span class="bar-legend-label">' + escapeHtml(String(d.label)) + '</span>' +
        '<span class="bar-legend-value">' + escapeHtml(String(d.value)) + '</span></li>';
    }).join('') + '</ul>';
  }

  // ---- Hover popover for the bars ----
  // Delegation on a single listener (instead of one per bar) because the
  // charts are regenerated on every resize — so nothing needs re-attaching
  // after re-rendering.
  function attachChartTooltip() {
    var tooltipEl = document.getElementById('chart-tooltip');
    if (!tooltipEl) return;

    function positionTooltip(evt) {
      var pad = 14;
      var left = evt.clientX + pad;
      var top = evt.clientY + pad;
      var maxLeft = window.innerWidth - tooltipEl.offsetWidth - pad;
      var maxTop = window.innerHeight - tooltipEl.offsetHeight - pad;
      tooltipEl.style.left = Math.max(pad, Math.min(left, maxLeft)) + 'px';
      tooltipEl.style.top = Math.max(pad, Math.min(top, maxTop)) + 'px';
    }

    document.addEventListener('mousemove', function (evt) {
      var bar = evt.target.closest && evt.target.closest('.bar-rect');
      if (!bar) {
        tooltipEl.style.display = 'none';
        return;
      }
      tooltipEl.innerHTML = '<span class="tt-label">' + escapeHtml(bar.getAttribute('data-label')) + '</span>' + escapeHtml(bar.getAttribute('data-value'));
      tooltipEl.style.display = 'block';
      positionTooltip(evt);
    });

    document.addEventListener('mouseleave', function () {
      tooltipEl.style.display = 'none';
    });
  }

  attachChartTooltip();

  // ---- Minimal SVG donut chart + legend ----
  function donutAndLegend(data, opts) {
    opts = opts || {};
    var size = opts.size || 140;
    var thickness = opts.thickness || 20;
    var r = (size - thickness) / 2;
    var cx = size / 2, cy = size / 2;
    var circumference = 2 * Math.PI * r;
    var total = data.reduce(function (s, d) { return s + d.value; }, 0);

    if (!data.length || total === 0) {
      return '<div class="empty">Not enough data yet.</div>';
    }

    var colors = opts.colors || PALETTE;
    var offset = 0;
    var segments = data.map(function (d, i) {
      var frac = d.value / total;
      var dash = frac * circumference;
      var seg = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + colors[i % colors.length] +
        '" stroke-width="' + thickness + '" stroke-dasharray="' + dash.toFixed(2) + ' ' + (circumference - dash).toFixed(2) +
        '" stroke-dashoffset="' + (-offset).toFixed(2) + '" transform="rotate(-90 ' + cx + ' ' + cy + ')">' +
        '<title>' + escapeHtml(d.label) + ': ' + d.value + ' (' + (frac * 100).toFixed(1) + '%)</title>' +
        '</circle>';
      offset += dash;
      return seg;
    }).join('');

    var svg = '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '" style="flex:none;">' + segments + '</svg>';

    var legend = '<ul class="legend">' + data.map(function (d, i) {
      var pct = ((d.value / total) * 100).toFixed(1);
      return '<li><span class="swatch" style="background:' + colors[i % colors.length] + ';"></span>' +
        '<span>' + escapeHtml(d.label) + '</span>' +
        '<span class="val">' + d.value + ' (' + pct + '%)</span></li>';
    }).join('') + '</ul>';

    return svg + legend;
  }

  // ---------------------------------------------------------------------
  // Load + normalize data
  // ---------------------------------------------------------------------

  var raw = document.getElementById('db').textContent;
  var entries = [];
  try {
    entries = JSON.parse(raw) || [];
  } catch (e) {
    console.error('Failed to read the analytics.html data block', e);
  }

  var totalSearches = entries.length;
  var uniqueProfiles = new Set(entries.map(function (e) { return e.profile.steamId; }));
  var allFriendIds = entries.flatMap(function (e) { return (e.friends || []).map(function (f) { return f.steamId; }); });
  var uniqueFriends = new Set(allFriendIds);
  var avgFriends = totalSearches
    ? (entries.reduce(function (sum, e) { return sum + (e.friends || []).length; }, 0) / totalSearches).toFixed(1)
    : '0';

  var gcMatches = entries.filter(function (e) { return e.profile && e.profile.gcName; }).length;
  var gcMatchRate = totalSearches ? ((gcMatches / totalSearches) * 100).toFixed(1) + '%' : '—';

  var privateListSearches = entries.filter(function (e) { return e.friendsVisibility === 'private'; }).length;

  var withCheater = entries.filter(function (e) { return e.cheater && typeof e.cheater.score === 'number'; });
  var cheaterScores = withCheater.map(function (e) { return normalizeScore(e.cheater.score); }).sort(function (a, b) { return a - b; });
  var avgCheater = withCheater.length
    ? (cheaterScores.reduce(function (s, v) { return s + v; }, 0) / cheaterScores.length).toFixed(1) + '%'
    : '—';
  // Median next to the mean: with scores clustered ~50, the pair tells
  // whether the average is pulled by a tail (mean != median) or the whole
  // distribution sits in one band (mean ~= median, the current disease).
  var medianCheater = withCheater.length
    ? (cheaterScores.length % 2
      ? cheaterScores[(cheaterScores.length - 1) / 2]
      : (cheaterScores[cheaterScores.length / 2 - 1] + cheaterScores[cheaterScores.length / 2]) / 2
      ).toFixed(1) + '%'
    : '—';

  var withDuration = entries.filter(function (e) { return typeof e.durationMs === 'number'; });
  var avgDuration = withDuration.length
    ? (withDuration.reduce(function (s, e) { return s + e.durationMs; }, 0) / withDuration.length / 1000).toFixed(1) + 's'
    : '—';

  var now = new Date();
  var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var startOfWeek = new Date(startOfToday.getTime() - 6 * 24 * 60 * 60 * 1000);
  var searchesToday = entries.filter(function (e) { return new Date(e.searchedAt) >= startOfToday; }).length;
  var searchesThisWeek = entries.filter(function (e) { return new Date(e.searchedAt) >= startOfWeek; }).length;

  // ---- Stat cards ----
  var statsEl = document.getElementById('stats');
  var stats = [
    { value: totalSearches, label: 'Recorded searches' },
    { value: uniqueProfiles.size, label: 'Unique searched profiles' },
    { value: uniqueFriends.size, label: 'Unique cataloged friends' },
    { value: avgFriends, label: 'Average friends per search' },
    { value: privateListSearches, label: 'Private-list searches' },
    { value: gcMatchRate, label: 'GamersClub match rate' },
    { value: searchesToday, label: 'Searches today' },
    { value: searchesThisWeek, label: 'Searches in the last 7 days' },
    { value: avgDuration, label: 'Average search duration' },
    { value: avgCheater, label: 'Average cheater probability' },
    { value: medianCheater, label: 'Median cheater probability' },
  ];
  statsEl.innerHTML = stats.map(function (s) {
    return '<div class="stat-card"><div class="value">' + escapeHtml(s.value) + '</div><div class="label">' + escapeHtml(s.label) + '</div></div>';
  }).join('');

  // ---- Searches per day (30 days) ----
  var dayCounts = {};
  entries.forEach(function (e) {
    var d = new Date(e.searchedAt);
    if (isNaN(d.getTime())) return;
    dayCounts[dayKey(d)] = (dayCounts[dayKey(d)] || 0) + 1;
  });
  var byDay = [];
  for (var i = 29; i >= 0; i -= 1) {
    var d = new Date(startOfToday.getTime() - i * 24 * 60 * 60 * 1000);
    byDay.push({
      label: String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0'),
      value: dayCounts[dayKey(d)] || 0,
    });
  }
  function renderByDayChart() {
    var el = document.getElementById('chart-by-day');
    el.innerHTML = svgBarChart(byDay, { width: containerWidth(el), color: 'var(--accent)' });
  }
  renderByDayChart();

  // ---- Searches by hour of day ----
  var hourCounts = new Array(24).fill(0);
  entries.forEach(function (e) {
    var d = new Date(e.searchedAt);
    if (isNaN(d.getTime())) return;
    hourCounts[d.getHours()] += 1;
  });
  var byHour = hourCounts.map(function (v, i) { return { label: String(i), value: v }; });
  function renderByHourChart() {
    var el = document.getElementById('chart-by-hour');
    el.innerHTML = svgBarChart(byHour, { width: containerWidth(el), color: 'var(--accent2)' });
  }
  renderByHourChart();

  // ---- Language ----
  var localeCounts = {};
  entries.forEach(function (e) {
    var loc = (e.requesterLocale || 'unknown').toLowerCase();
    localeCounts[loc] = (localeCounts[loc] || 0) + 1;
  });
  document.getElementById('chart-locale').innerHTML = donutAndLegend(topNPlusOthers(localeCounts, 6));

  // ---- Browser language ----
  var browserLangCounts = {};
  entries.forEach(function (e) {
    var lang = (e.requesterBrowserLanguage || 'unknown').toLowerCase();
    browserLangCounts[lang] = (browserLangCounts[lang] || 0) + 1;
  });
  document.getElementById('chart-browser-lang').innerHTML = donutAndLegend(topNPlusOthers(browserLangCounts, 6));

  // ---- Device ----
  var deviceCounts = {};
  entries.forEach(function (e) {
    var dev = e.device || 'unknown';
    deviceCounts[dev] = (deviceCounts[dev] || 0) + 1;
  });
  document.getElementById('chart-device').innerHTML = donutAndLegend(topNPlusOthers(deviceCounts, 6));

  // ---- Searcher countries ----
  var countryCounts = {};
  entries.forEach(function (e) {
    var c = e.requesterCountry || 'unknown';
    countryCounts[c] = (countryCounts[c] || 0) + 1;
  });
  var countryData = topNPlusOthers(countryCounts, 8).map(function (d, i) {
    return { label: (flagEmoji(d.label) ? flagEmoji(d.label) + ' ' : '') + d.label, value: d.value, color: PALETTE[i % PALETTE.length] };
  });
  function renderCountryChart() {
    var el = document.getElementById('chart-country');
    el.innerHTML = svgBarChart(countryData, { width: containerWidth(el) });
  }
  renderCountryChart();

  // ---- Cheater probability distribution ----
  // Bucketed by the report outcome bands (same cuts as CheaterReport:
  // VERY_TRUSTED <35, INNOCENT 35-45, INCONCLUSIVE 45-55, SUSPECT 55-65,
  // HIGHLY >=65), not by flat 10% bins — so the chart reads as "how many
  // profiles landed in each verdict" instead of hiding the cluster.
  var cheaterBands = [
    { label: 'Very trusted (<35%)', color: '#7ee081', test: function (v) { return v < 35; } },
    { label: 'Innocent (35-45%)', color: '#b5e48c', test: function (v) { return v >= 35 && v < 45; } },
    { label: 'Inconclusive (45-55%)', color: '#ffb454', test: function (v) { return v >= 45 && v < 55; } },
    { label: 'Suspect (55-65%)', color: '#ff9f43', test: function (v) { return v >= 55 && v < 65; } },
    { label: 'Highly suspect (>=65%)', color: '#ff6b6b', test: function (v) { return v >= 65; } },
  ];
  var cheaterData = cheaterBands.map(function (band) {
    var count = 0;
    withCheater.forEach(function (e) {
      if (band.test(normalizeScore(e.cheater.score))) count += 1;
    });
    return { label: band.label, value: count, color: band.color };
  });
  function renderCheaterChart() {
    var el = document.getElementById('chart-cheater');
    el.innerHTML = withCheater.length
      ? svgBarChart(cheaterData, { width: containerWidth(el) })
      : '<div class="empty">No cheater reports computed yet.</div>';
  }
  renderCheaterChart();

  // ---- Most predicted locations ----
  var locationCounts = {};
  entries.forEach(function (e) {
    var g = e.locationGuess && e.locationGuess[0];
    if (g && g.location) {
      var locLabel = formatLocation(g.location);
      locationCounts[locLabel] = (locationCounts[locLabel] || 0) + 1;
    }
  });
  var locationData = topNPlusOthers(locationCounts, 10).map(function (d, i) {
    return { label: d.label, value: d.value, color: PALETTE[i % PALETTE.length] };
  });
  function renderLocationsChart() {
    var el = document.getElementById('chart-locations');
    if (!locationData.length) {
      el.innerHTML = '<div class="empty">No location predictions recorded yet.</div>';
      return;
    }
    el.innerHTML = svgBarChart(locationData, { width: containerWidth(el), height: 170, showLabels: false }) + barLegendHtml(locationData);
  }
  renderLocationsChart();

  // ---- Games Analytics (Top 20) ----
  // Metric 1: Average per searched profile (diluted across the total population)
  // Metric 2: Engagement average (only among those who played)
  var TOP_GAMES_LIMIT = 20; // CONFIGURABLE
  var CS_HOUR_THRESHOLD = 300; // CONFIGURABLE

  var gameStats = {};
  var csActiveCount = 0;
  var totalProfiles = entries.length || 0;

  entries.forEach(function (e) {
    if (e.isCSActive) csActiveCount += 1;

    var games = e.gamesSnapshot || [];
    games.forEach(function (game) {
      if (!gameStats[game.name]) {
        gameStats[game.name] = { totalHours: 0, profilesCount: 0 };
      }
      gameStats[game.name].totalHours += Number(game.playtimeHours) || 0;
      gameStats[game.name].profilesCount += 1;
    });
  });

  var topGamesPerProfile = Object.keys(gameStats)
    .map(function (name) {
      var stats = gameStats[name];
      return {
        name: name,
        avgPerProfile: totalProfiles > 0
          ? Math.round((stats.totalHours / totalProfiles) * 10) / 10
          : 0,
        avgEngagement: stats.profilesCount > 0
          ? Math.round((stats.totalHours / stats.profilesCount) * 10) / 10
          : 0,
        profilesCount: stats.profilesCount,
      };
    })
    .sort(function (a, b) { return b.avgPerProfile - a.avgPerProfile; });

  var topGamesPerProfileLimit = topGamesPerProfile.slice(0, TOP_GAMES_LIMIT);

  var topGamesEngagement = topGamesPerProfile.slice().sort(function (a, b) { return b.avgEngagement - a.avgEngagement; }).slice(0, TOP_GAMES_LIMIT);

  function renderGameChart(games, elementId, showMetric) {
    var el = document.getElementById(elementId);
    if (!games.length) {
      el.innerHTML = '<div class="empty">No games data. Run: node scripts/enrich-analytics.mjs</div>';
      return;
    }

    var maxValue = Math.max.apply(null, games.map(function (g) { 
      return showMetric === 'engagement' ? g.avgEngagement : g.avgPerProfile;
    }));
    var html = '<div class="games-chart">';

    games.forEach(function (game, idx) {
      var value = showMetric === 'engagement' ? game.avgEngagement : game.avgPerProfile;
      var barWidth = maxValue > 0 ? (value / maxValue) * 100 : 0;
      var barColor = PALETTE[idx % PALETTE.length];
      var subtitle = showMetric === 'engagement' 
        ? '(' + game.profilesCount + ' players)'
        : '(' + game.profilesCount + ' profiles)';
      
      html += '<div class="game-row">' +
        '<div class="game-label">' + (idx + 1) + '. ' + escapeHtml(game.name) + '</div>' +
        '<div class="game-bar" style="position:relative; background:#2a2e37; height:24px; border-radius:4px; overflow:hidden;">' +
          '<div style="width:' + barWidth + '%; height:100%; background:' + barColor + '; transition:width 0.3s ease;"></div>' +
          '<div style="position:absolute; top:0; right:8px; height:100%; display:flex; align-items:center; color:var(--text); font-size:12px; font-weight:bold;">' +
            value + 'h ' + subtitle + '</div>' +
        '</div>' +
      '</div>';
    });

    html += '</div>';
    el.innerHTML = html;
  }

  renderGameChart(topGamesPerProfileLimit, 'chart-games-per-profile', 'per-profile');
  renderGameChart(topGamesEngagement, 'chart-games-engagement', 'engagement');

  function renderCSActiveChart() {
    var el = document.getElementById('chart-cs-active');
    var total = entries.length;
    var percentage = total > 0 ? Math.round((csActiveCount / total) * 100) : 0;

    var html = '<div class="cs-active-panel">' +
      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px;">' +
        '<div style="background:rgba(167, 139, 250, 0.1); border:1px solid rgba(167, 139, 250, 0.3); border-radius:6px; padding:12px; text-align:center;">' +
          '<div style="font-size:24px; font-weight:bold; color:#a78bfa;">' + csActiveCount + '</div>' +
          '<div style="font-size:12px; color:var(--muted); margin-top:4px;">CS Active</div>' +
        '</div>' +
        '<div style="background:rgba(167, 139, 250, 0.1); border:1px solid rgba(167, 139, 250, 0.3); border-radius:6px; padding:12px; text-align:center;">' +
          '<div style="font-size:24px; font-weight:bold; color:#a78bfa;">' + percentage + '%</div>' +
          '<div style="font-size:12px; color:var(--muted); margin-top:4px;">of ' + total + ' profiles</div>' +
        '</div>' +
      '</div>' +
    '</div>';

    el.innerHTML = html;
  }
  renderCSActiveChart();

  // Rebuilds the charts whenever the layout changes width
  // (e.g. resizing the window), to keep the viewBox 1:1 with the container.
  window.addEventListener('resize', debounce(function () {
    renderByDayChart();
    renderByHourChart();
    renderCountryChart();
    renderCheaterChart();
    renderLocationsChart();
    renderGameChart(topGamesPerProfileLimit, 'chart-games-per-profile', 'per-profile');
    renderGameChart(topGamesEngagement, 'chart-games-engagement', 'engagement');
    renderWatchSignups();
    renderWatchDeliveries();
  }, 200));

  // ---------------------------------------------------------------------
  // Watch section (opt-in Steam-profile monitoring: counts + locales + bot
  // deliveries + current status). Reads the #watch-db JSON block (null when
  // the reads failed — every panel below degrades to an explicit empty
  // state instead of breaking the page, same fail-open contract as the
  // server side that served null).
  // ---------------------------------------------------------------------

  var watch = null;
  try {
    watch = JSON.parse(document.getElementById('watch-db').textContent);
  } catch (e) {
    console.error('Failed to read the watch data block', e);
  }

  function watchDayCounts(rows, getDate) {
    var counts = {};
    rows.forEach(function (r) {
      var stamp = getDate(r);
      if (typeof stamp !== 'string' || !stamp) return;
      var d = new Date(stamp);
      if (isNaN(d.getTime())) return;
      counts[dayKey(d)] = (counts[dayKey(d)] || 0) + 1;
    });
    var out = [];
    for (var i = 29; i >= 0; i -= 1) {
      var day = new Date(startOfToday.getTime() - i * 24 * 60 * 60 * 1000);
      out.push({
        label: String(day.getDate()).padStart(2, '0') + '/' + String(day.getMonth() + 1).padStart(2, '0'),
        value: counts[dayKey(day)] || 0,
      });
    }
    return out;
  }

  function renderWatchSignups() {
    if (!watch) return;
    var el = document.getElementById('chart-watch-signups');
    var byDay = watchDayCounts(watch.accounts || [], function (a) { return a.createdAt; });
    el.innerHTML = svgBarChart(byDay, { width: containerWidth(el), color: 'var(--accent5)' });
  }

  function renderWatchDeliveries() {
    if (!watch) return;
    var el = document.getElementById('chart-watch-deliveries');
    var sent = (watch.events || []).filter(function (ev) {
      return ev.status === 'sent' && typeof ev.sentAt === 'string' && ev.sentAt;
    });
    var byDay = watchDayCounts(sent, function (ev) { return ev.sentAt; });
    el.innerHTML = svgBarChart(byDay, { width: containerWidth(el), color: 'var(--accent2)' });
  }

  (function renderWatchSection() {
    var statsEl = document.getElementById('watch-stats');
    if (!watch) {
      statsEl.innerHTML = '<div class="stat-card"><div class="value">—</div><div class="label">Watch data unavailable</div></div>';
      ['chart-watch-signups', 'chart-watch-locales', 'chart-watch-deliveries'].forEach(function (id) {
        document.getElementById(id).innerHTML = '<div class="empty">Watch data unavailable.</div>';
      });
      document.getElementById('watch-delivery-totals').innerHTML = '<li class="empty">Watch data unavailable.</li>';
      return;
    }
    var accounts = watch.accounts || [];
    var watched = watch.watched || [];
    var events = watch.events || [];

    // Raw counts only, deliberately no cross-table rates: confirmed_at is
    // written solely by the legacy confirm-link lane (single-state logins
    // never touch it), and accounts vs watched_profiles populations can
    // drift (grandfathered rows) — so any signup-denominated % would decay
    // or exceed 100% without anything breaking. Counts stay truthful.
    var signups = accounts.length;
    var active = watched.filter(function (w) { return w.status === 'active'; }).length;
    var pending = watched.filter(function (w) { return w.status !== 'active'; }).length;
    var weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    var loginsWeek = accounts.filter(function (a) {
      return typeof a.lastLoginAt === 'string' && Date.parse(a.lastLoginAt) >= weekAgo;
    }).length;
    statsEl.innerHTML = [
      { value: signups, label: 'Watch accounts' },
      { value: active, label: 'Active watches' },
      { value: pending, label: 'Pending watches' },
      { value: loginsWeek, label: 'Active users (7d)' },
    ].map(function (s) {
      return '<div class="stat-card"><div class="value">' + escapeHtml(s.value) + '</div><div class="label">' + escapeHtml(s.label) + '</div></div>';
    }).join('');

    renderWatchSignups();

    var watcherLocales = {};
    // accounts ONLY: accounts and watched_profiles are 1:1 for the same user
    // (signup creates both with the same locale), so counting both would
    // count every normal user twice and skew the donut. watched rows without
    // an account (grandfathered pre-confirmation rows) are rare enough that
    // one truthful population beats a doubled one.
    accounts.forEach(function (a) {
      var key = (typeof a.locale === 'string' && a.locale) || 'unknown';
      watcherLocales[key] = (watcherLocales[key] || 0) + 1;
    });
    var localeData = topNPlusOthers(watcherLocales, 6);
    document.getElementById('chart-watch-locales').innerHTML = localeData.length
      ? donutAndLegend(localeData)
      : '<div class="empty">No data yet.</div>';

    renderWatchDeliveries();

    // Lanes derived from the data, not a hardcoded list: a new event kind
    // added to WatchEventKind/validKinds shows up here automatically instead
    // of silently disappearing from the breakdown. Single pass over events
    // (not one .filter() per lane per status).
    var totals = {};
    events.forEach(function (ev) {
      var lane = (typeof ev.kind === 'string' && ev.kind) || 'unknown';
      if (!totals[lane]) totals[lane] = { sent: 0, dropped: 0 };
      if (ev.status === 'sent') totals[lane].sent += 1;
      else if (ev.status === 'dropped') totals[lane].dropped += 1;
    });
    var laneNames = Object.keys(totals).sort();
    var totalsHtml = laneNames.length
      ? laneNames.map(function (kind) {
          var t = totals[kind];
          return '<li><span>' + escapeHtml(kind) + '</span><span class="count">' + t.sent + ' sent · ' + t.dropped + ' dropped</span></li>';
        }).join('')
      : '<li class="empty">No deliveries yet.</li>';
    var live = watch.liveness;
    var liveLine;
    // STALE_MS mirrors BOT_ONLINE_MAX_AGE_MS in src/lib/watch/botLiveness.ts:
    // past it the bot process is down even when the last row said connected.
    var STALE_MS = 4 * 60 * 1000;
    if (!live || typeof live.beatAt !== 'string') {
      liveLine = 'Bot heartbeat: unknown (no beat recorded yet)';
    } else {
      var beatMs = Date.parse(live.beatAt);
      if (!isFinite(beatMs)) {
        liveLine = 'Bot heartbeat: unknown (invalid beat timestamp)';
      } else {
        var ageMs = Math.max(0, Date.now() - beatMs);
        var ageText;
        if (ageMs < 60 * 1000) {
          ageText = Math.round(ageMs / 1000) + 's ago';
        } else if (ageMs < 60 * 60 * 1000) {
          ageText = Math.round(ageMs / (60 * 1000)) + 'm ago';
        } else if (ageMs < 24 * 60 * 60 * 1000) {
          ageText = Math.round(ageMs / (60 * 60 * 1000)) + 'h ago';
        } else {
          ageText = Math.round(ageMs / (24 * 60 * 60 * 1000)) + 'd ago';
        }
        var sessionText = live.connected ? 'connected' : 'disconnected';
        if (ageMs >= STALE_MS) {
          sessionText = 'stale, likely offline (last: ' + sessionText + ')';
        }
        liveLine = 'Bot heartbeat: ' + ageText + ', session ' + sessionText;
      }
    }
    document.getElementById('watch-delivery-totals').innerHTML = totalsHtml +
      '<li><span>' + escapeHtml(liveLine) + '</span><span class="count">now</span></li>';
  })();

  // ---- Ranking: most searched profiles / most frequent friends ----
  function topRankHtml(counts, labelFn) {
    var arr = Object.keys(counts).map(function (k) { return { key: k, count: counts[k].count, meta: counts[k].meta }; });
    arr.sort(function (a, b) { return b.count - a.count; });
    arr = arr.slice(0, 8);
    if (!arr.length) return '<li class="empty">No data yet.</li>';
    return arr.map(function (item) {
      return '<li><span>' + escapeHtml(labelFn(item)) + '</span><span class="count">' + item.count + 'x</span></li>';
    }).join('');
  }

  var profileCounts = {};
  entries.forEach(function (e) {
    var id = e.profile.steamId;
    if (!profileCounts[id]) profileCounts[id] = { count: 0, meta: e.profile };
    profileCounts[id].count += 1;
    profileCounts[id].meta = e.profile; // keeps the most recent data
  });
  document.getElementById('top-profiles').innerHTML = topRankHtml(profileCounts, function (item) {
    var flag = flagEmoji(item.meta.countryCode);
    return (flag ? flag + ' ' : '') + (item.meta.nickname || item.meta.gcName || item.key);
  });

  var friendCounts = {};
  entries.forEach(function (e) {
    (e.friends || []).forEach(function (f) {
      if (!friendCounts[f.steamId]) friendCounts[f.steamId] = { count: 0, meta: f };
      friendCounts[f.steamId].count += 1;
      friendCounts[f.steamId].meta = f;
    });
  });
  document.getElementById('top-friends').innerHTML = topRankHtml(friendCounts, function (item) {
    var flag = flagEmoji(item.meta.countryCode);
    return (flag ? flag + ' ' : '') + (item.meta.nickname || item.meta.gcName || item.key);
  });

  // ---------------------------------------------------------------------
  // History table
  // ---------------------------------------------------------------------

  var body = document.getElementById('searches-body');
  var emptyMsg = document.getElementById('empty-msg');

  function renderRows(list) {
    if (!list.length) {
      body.innerHTML = '';
      emptyMsg.style.display = 'block';
      return;
    }
    emptyMsg.style.display = 'none';
    body.innerHTML = list.slice().reverse().map(function (e) {
      var friends = e.friends || [];
      var friendsList = friends.map(function (f) {
        var prob = typeof f.probability === 'number' ? ' (' + f.probability.toFixed(0) + '%)' : '';
        return '<li>' + escapeHtml(f.nickname || f.steamId) + prob + (f.gcName ? ' — GC: ' + escapeHtml(f.gcName) : '') + '</li>';
      }).join('');
      var friendsCell = friends.length
        ? '<details><summary>' + friends.length + ' friend(s)</summary><ul>' + friendsList + '</ul></details>'
        : '0';

      var profileLabel = escapeHtml(e.profile.nickname || e.profile.steamId);
      var flag = flagEmoji(e.profile.countryCode);
      var profileLink = safeProfileLink(e.profile.steamUrl, (flag ? flag + ' ' : '') + profileLabel);

      var topLoc = e.locationGuess && e.locationGuess[0]
        ? escapeHtml(formatLocation(e.locationGuess[0].location)) + ' <span class="muted-small">(' + (typeof e.locationGuess[0].probability === 'number' ? e.locationGuess[0].probability.toFixed(0) : '') + '%)</span>'
        : '<span class="muted-small">—</span>';

      var cheaterCell = e.cheater && typeof e.cheater.score === 'number'
        ? riskBadge(normalizeScore(e.cheater.score))
        : '<span class="muted-small">—</span>';

      var originBits = [];
      if (e.requesterLocale) originBits.push(e.requesterLocale.toUpperCase());
      var originFlag = flagEmoji(e.requesterCountry);
      if (originFlag) originBits.push(originFlag);
      if (e.device) originBits.push(e.device === 'mobile' ? '📱' : '💻');
      if (e.requesterBrowserLanguage) originBits.push('🌐 ' + e.requesterBrowserLanguage);
      var originCell = originBits.length ? originBits.join(' ') : '<span class="muted-small">—</span>';

      var durationCell = typeof e.durationMs === 'number'
        ? (e.durationMs / 1000).toFixed(1) + 's'
        : '<span class="muted-small">—</span>';

      return '<tr>' +
        '<td>' + escapeHtml(formatDate(e.searchedAt)) + '</td>' +
        '<td>' + profileLink + '<br><span class="muted-small">' + escapeHtml(e.profile.steamId) + '</span></td>' +
        '<td>' + escapeHtml(e.profile.gcName || '—') + '</td>' +
        '<td>' + friendsCell + '</td>' +
        '<td>' + topLoc + '</td>' +
        '<td>' + cheaterCell + '</td>' +
        '<td>' + originCell + '</td>' +
        '<td>' + durationCell + '</td>' +
        '</tr>';
    }).join('');
  }

  renderRows(entries);

  document.getElementById('filter').addEventListener('input', function (ev) {
    var q = ev.target.value.trim().toLowerCase();
    if (!q) return renderRows(entries);
    var filtered = entries.filter(function (e) {
      var haystack = [
        e.profile.steamId, e.profile.nickname, e.profile.gcName,
        e.requesterLocale, e.requesterCountry, e.device,
        e.locationGuess && e.locationGuess[0] && e.locationGuess[0].location,
      ].concat((e.friends || []).flatMap(function (f) { return [f.steamId, f.nickname, f.gcName]; }))
        .filter(Boolean).join(' ').toLowerCase();
      return haystack.indexOf(q) !== -1;
    });
    renderRows(filtered);
  });

  // ---- Export CSV ----
  document.getElementById('export-csv').addEventListener('click', function () {
    var header = ['Date', 'SteamID', 'Nickname', 'GC Name', 'Language', 'Country', 'Device', 'Duration(s)', 'Cheater(%)', 'Predicted location', 'Friend count'];
    var rows = [header];
    entries.forEach(function (e) {
      rows.push([
        e.searchedAt,
        e.profile.steamId,
        e.profile.nickname || '',
        e.profile.gcName || '',
        e.requesterLocale || '',
        e.requesterCountry || '',
        e.device || '',
        typeof e.durationMs === 'number' ? (e.durationMs / 1000).toFixed(1) : '',
        e.cheater && typeof e.cheater.score === 'number' ? e.cheater.score.toFixed(1) : '',
        (e.locationGuess && e.locationGuess[0] && e.locationGuess[0].location) || '',
        (e.friends || []).length,
      ]);
    });

    var csv = rows.map(function (r) {
      return r.map(function (v) {
        var s = csvSafeCell(v);
        s = s.replace(/"/g, '""');
        return /[",\\n]/.test(s) ? '"' + s + '"' : s;
      }).join(',');
    }).join('\\n');

    var blob = new Blob(['\\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'steamreveal-analytics-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
})();
</script>

</body>
</html>`;

/** Closes the entries block and opens the watch block (joined by buildAnalyticsHtml). */
const WATCH_DB_MID = `</script>
<script type="application/json" id="watch-db">`;

/**
 * Assembles a full analytics.html from the dashboard shell (HEAD/TAIL,
 * above) around two already-serialized JSON strings: the searches array
 * for the <script id="db"> block and the Watch aggregates (or 'null' when
 * those reads failed) for the <script id="watch-db"> block.
 *
 * Deliberately takes pre-serialized strings rather than SearchRecord[]:
 * this file only knows about markup/styling/behavior, not about what a
 * "search record" is or how it should be escaped for embedding (that's
 * dashboardRender.ts's job -- see its `<` -> `\u003c` escaping, which
 * guards against a malicious nickname/URL containing "</script>").
 * Keeping that split also avoids a circular import, since dashboardRender.ts
 * already imports from this file.
 */

export const buildAnalyticsHtml = (
  serializedEntriesJson: string,
  serializedWatchJson: string = 'null',
): string =>
  `${ANALYTICS_DASHBOARD_HEAD}\n${serializedEntriesJson}\n${WATCH_DB_MID}\n${serializedWatchJson}\n${ANALYTICS_DASHBOARD_TAIL}`;

/**
 * Convenience wrapper for an empty-history dashboard — used by tests and by
 * dashboardRender.ts's renderDashboard() when there are no records at all.
 */
export const buildEmptyAnalyticsHtml = (): string => buildAnalyticsHtml('[]');
