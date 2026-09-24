/**
 * Functional coverage for the dashboard's interactive tables (search
 * history + cheater reports): the inline script is executed for real in
 * jsdom against sample entries, then sort clicks and filter input are
 * driven like a user would. This pins behavior the compile-only test in
 * dashboardTemplate.test.ts cannot see (row order, filtering).
 */
import { fireEvent } from '@testing-library/react';
import { buildAnalyticsHtml } from './dashboardTemplate';

const SAMPLE = JSON.stringify([
  {
    id: 's1',
    searchedAt: '2026-09-01T10:00:00.000Z',
    profile: { steamId: '76561198000000001', nickname: 'Alice' },
    friends: [{ steamId: '76561198000000009', nickname: 'Zed' }],
    cheater: {
      score: 0.2,
      bannedFriendsCount: 0,
      computedAt: '2026-09-01T11:00:00.000Z',
    },
  },
  {
    id: 's2',
    searchedAt: '2026-09-02T10:00:00.000Z',
    profile: { steamId: '76561198000000002', nickname: 'Bob' },
    friends: [],
    cheater: {
      score: 0.7,
      bannedFriendsCount: 3,
      computedAt: '2026-09-02T11:00:00.000Z',
    },
  },
  {
    id: 's3',
    searchedAt: '2026-09-03T10:00:00.000Z',
    profile: { steamId: '76561198000000003', nickname: 'Carol' },
    friends: [],
  },
]);

function loadDashboard(entriesJson: string = SAMPLE) {
  const html = buildAnalyticsHtml(entriesJson, 'null');
  document.body.innerHTML = html;
  const inner = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!inner) throw new Error('inline <script> has no captured body');
  // eslint-disable-next-line no-eval
  eval(inner[1]);
}

/**
 * Executes the dashboard script with a populated login-funnel block so the
 * funnel panel's DATA path (5 cards, number formatting, rate text) actually
 * runs — the default 'null' block only ever exercises the "unavailable"
 * early return, and substring tests can't catch a runtime throw here.
 */
function loadDashboardWithFunnel(
  funnel: Record<string, unknown>,
  entriesJson: string = SAMPLE,
) {
  const html = buildAnalyticsHtml(entriesJson, 'null', JSON.stringify(funnel));
  document.body.innerHTML = html;
  const inner = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!inner) throw new Error('inline <script> has no captured body');
  // eslint-disable-next-line no-eval
  eval(inner[1]);
}

function funnelCardTexts(): string[] {
  return Array.prototype.map.call(
    document.querySelectorAll('#login-funnel-stats .stat-card'),
    function (card) {
      // textContent concatenates the value/label divs WITHOUT whitespace —
      // read them separately and join, so assertions read "300 Sign-in clicks".
      const value = card.querySelector('.value')?.textContent || '';
      const label = card.querySelector('.label')?.textContent || '';
      return `${value} ${label}`.trim();
    },
  ) as string[];
}

function cheaterOutcomes(): string[] {
  return Array.prototype.map.call(
    document.querySelectorAll('#cheater-body tr td:nth-child(5)'),
    function (td) {
      return (td.textContent || '').trim();
    },
  ) as string[];
}

function cheaterChartCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  Array.prototype.forEach.call(
    document.querySelectorAll('#chart-cheater .bar-rect'),
    function (rect) {
      const label = (rect.getAttribute('data-label') || '').trim();
      counts[label] = Number(rect.getAttribute('data-value'));
    },
  );
  return counts;
}

function cheaterBadgeClasses(): string[] {
  return Array.prototype.map.call(
    document.querySelectorAll('#cheater-body tr td:nth-child(4) span.badge'),
    function (span) {
      return (span.className || '').trim();
    },
  ) as string[];
}

function cheaterLegendCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  Array.prototype.forEach.call(
    document.querySelectorAll('#chart-cheater .bar-legend li'),
    function (li) {
      const label = (
        li.querySelector('.bar-legend-label')?.textContent || ''
      ).trim();
      counts[label] = Number(
        li.querySelector('.bar-legend-value')?.textContent,
      );
    },
  );
  return counts;
}

function cheaterBarFill(dataLabel: string): string | null {
  const rect = document.querySelector(
    '#chart-cheater .bar-rect[data-label="' + dataLabel + '"]',
  );
  return rect ? rect.getAttribute('fill') : null;
}

function cheaterNicknames(): string[] {
  return Array.prototype.map.call(
    document.querySelectorAll('#cheater-body tr td:nth-child(2)'),
    function (td) {
      return (td.textContent || '').trim();
    },
  ) as string[];
}

function historyNicknames(): string[] {
  // History profile cell holds "nickname<br>steamId" (a link only when the
  // entry carries a steamUrl) — read just the leading nickname text.
  return Array.prototype.map.call(
    document.querySelectorAll('#searches-body tr td:nth-child(2)'),
    function (td) {
      var first = td.firstChild;
      var text =
        first && first.nodeType === 3 ? first.textContent : td.textContent;
      return (text || '').trim();
    },
  ) as string[];
}

function clickTh(tableId: string, sortKey: string) {
  const th = document.querySelector(
    '#' + tableId + ' th[data-sort="' + sortKey + '"]',
  );
  if (!th) throw new Error('missing th[data-sort="' + sortKey + '"]');
  fireEvent.click(th);
}

describe('dashboard interactive tables', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders cheater rows highest-score-first by default', () => {
    loadDashboard();
    // Bob 70% > Alice 20%; Carol has no cheater row at all.
    expect(cheaterNicknames()).toEqual(['Bob', 'Alice']);
  });

  it('sorts the cheater table by profile name on header click', () => {
    loadDashboard();
    clickTh('cheater-table', 'profile');
    expect(cheaterNicknames()).toEqual(['Alice', 'Bob']);
    // Second click flips direction.
    clickTh('cheater-table', 'profile');
    expect(cheaterNicknames()).toEqual(['Bob', 'Alice']);
  });

  it('filters cheater rows by nickname or steamId', () => {
    loadDashboard();
    const input = document.getElementById('cheater-filter');
    if (!input) throw new Error('missing #cheater-filter');
    fireEvent.input(input, { target: { value: 'alice' } });
    expect(cheaterNicknames()).toEqual(['Alice']);
    fireEvent.input(input, { target: { value: '76561198000000002' } });
    expect(cheaterNicknames()).toEqual(['Bob']);
    fireEvent.input(input, { target: { value: 'nobody-here' } });
    expect(cheaterNicknames()).toEqual([]);
  });

  it('keeps search history newest-first by default and flips on Date click', () => {
    loadDashboard();
    expect(historyNicknames()).toEqual(['Carol', 'Bob', 'Alice']);
    clickTh('searches-table', 'date');
    expect(historyNicknames()).toEqual(['Alice', 'Bob', 'Carol']);
  });

  it('filters history rows with the existing search box', () => {
    loadDashboard();
    const input = document.getElementById('filter');
    if (!input) throw new Error('missing #filter');
    fireEvent.input(input, { target: { value: 'bob' } });
    expect(historyNicknames()).toEqual(['Bob']);
  });

  it('executes the funnel panel data path: 5 cards, numbers, rate text', () => {
    // Also proves escapeHtml is safe on NUMBER values (String() internally)
    // — a throw here would abort the whole IIFE and fail the table tests.
    loadDashboardWithFunnel({
      ctaEvents: 300,
      ctaSessions: 250,
      completions: 3,
      completedSessions: 2,
      unattributedCompletions: 1,
      conversionRate: 0.8,
      generatedAt: '2026-09-24T00:00:00.000Z',
    });

    expect(funnelCardTexts()).toEqual([
      '300 Sign-in clicks',
      '250 Clicking sessions',
      '2 Logged-in sessions',
      '1 Unattributed logins',
      '0.8% Click → login conversion',
    ]);

    // The rest of the dashboard still rendered after the funnel section.
    expect(historyNicknames()).toEqual(['Carol', 'Bob', 'Alice']);
  });

  it('renders the funnel panel with a null rate (—, never 0.0% or NaN)', () => {
    loadDashboardWithFunnel({
      ctaEvents: 0,
      ctaSessions: 0,
      completions: 0,
      completedSessions: 0,
      unattributedCompletions: 0,
      conversionRate: null,
      generatedAt: '2026-09-24T00:00:00.000Z',
    });

    expect(funnelCardTexts()).toContain('— Click → login conversion');
  });

  it('keeps histogram bins, band legend, outcome labels and outcome sort consistent at band boundaries', () => {
    // Cross-consistency guard for every consumer of cheaterBandIndex (the
    // histogram bins/colors, the band-total legend, cheaterOutcome labels,
    // cheaterOutcomeRank sort key): a boundary edit that touched only some
    // of them would fail here. Scores sit exactly on the cuts (0-1
    // fractions, normalized ×100).
    const boundaryEntries = JSON.stringify(
      [
        { nick: 'VT20', score: 0.2 },
        { nick: 'IN21', score: 0.21 },
        { nick: 'IC45', score: 0.45 },
        { nick: 'IC58', score: 0.58 },
        { nick: 'SU59', score: 0.59 },
        { nick: 'SU65', score: 0.65 },
        { nick: 'HS66', score: 0.66 },
      ].map((r, i) => ({
        id: 'b' + (i + 1),
        searchedAt: '2026-09-0' + (i + 1) + 'T10:00:00.000Z',
        profile: {
          steamId: '765611980000000' + (10 + i),
          nickname: r.nick,
        },
        friends: [],
        cheater: {
          score: r.score,
          bannedFriendsCount: 0,
          computedAt: '2026-09-0' + (i + 1) + 'T11:00:00.000Z',
        },
      })),
    );
    loadDashboard(boundaryEntries);

    // 1. Table labels: default score-desc render must show the band outcome
    // matching the server-side classifyCheaterOutcome strictness
    // (20→Very trusted, 58→Inconclusive, 65→Suspect).
    expect(cheaterNicknames()).toEqual([
      'HS66',
      'SU65',
      'SU59',
      'IC58',
      'IC45',
      'IN21',
      'VT20',
    ]);
    expect(cheaterOutcomes()).toEqual([
      'Highly suspect',
      'Suspect',
      'Suspect',
      'Inconclusive',
      'Inconclusive',
      'Innocent',
      'Very trusted',
    ]);

    // 2. Histogram bins count the same boundaries into 10% buckets
    // (half-open [lo, hi): 20 lands in 20-30%, 65 in 60-70%).
    expect(cheaterChartCounts()).toEqual({
      '0-10%': 0,
      '10-20%': 0,
      '20-30%': 2,
      '30-40%': 0,
      '40-50%': 1,
      '50-60%': 2,
      '60-70%': 2,
      '70-80%': 0,
      '80-90%': 0,
      '90-100%': 0,
    });

    // 2b. Bin colors follow the band of each bin's midpoint (documented
    // approximation for the bins straddling a cut): mid 25 → Innocent
    // green, mid 45 → Inconclusive amber.
    expect(cheaterBarFill('20-30%')).toBe('#b5e48c');
    expect(cheaterBarFill('40-50%')).toBe('#ffb454');
    expect(cheaterBarFill('60-70%')).toBe('#ff9f43');

    // 2c. The band-total legend still aggregates the same boundaries into
    // the five outcome bands (1/1/2/2/1), agreeing with the table labels.
    expect(cheaterLegendCounts()).toEqual({
      'Very trusted (<=20%)': 1,
      'Innocent (20-45%)': 1,
      'Inconclusive (45-58%)': 2,
      'Suspect (58-65%)': 2,
      'Highly suspect (>65%)': 1,
    });

    // 2b. Risk badge colors derive from the same band index (no fixed-cut
    // drift): bands 3-4 high/red, band 2 mid/amber, bands 0-1 low/green.
    expect(cheaterBadgeClasses()).toEqual([
      'badge risk-high',
      'badge risk-high',
      'badge risk-high',
      'badge risk-mid',
      'badge risk-mid',
      'badge risk-low',
      'badge risk-low',
    ]);

    // 3. Outcome sort (rank key) orders rows identically to score sort:
    // first click → desc (highest band first), second → asc. Ties keep
    // input order (stable sort of the unfiltered list on every render).
    clickTh('cheater-table', 'outcome');
    expect(cheaterNicknames()).toEqual([
      'HS66',
      'SU59',
      'SU65',
      'IC45',
      'IC58',
      'IN21',
      'VT20',
    ]);
    clickTh('cheater-table', 'outcome');
    expect(cheaterNicknames()).toEqual([
      'VT20',
      'IN21',
      'IC45',
      'IC58',
      'SU59',
      'SU65',
      'HS66',
    ]);
  });
});
