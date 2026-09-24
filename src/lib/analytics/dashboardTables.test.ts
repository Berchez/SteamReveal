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

  it('keeps chart buckets, outcome labels and outcome sort consistent at band boundaries', () => {
    // Cross-consistency guard for the three consumers of cheaterBandIndex
    // (chart buckets, cheaterOutcome labels, cheaterOutcomeRank sort key):
    // a boundary edit that touched only one of them would fail here.
    // Scores sit exactly on the cuts (0-1 fractions, normalized ×100).
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

    // 2. Chart buckets count the same boundaries into the same bands.
    expect(cheaterChartCounts()).toEqual({
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
