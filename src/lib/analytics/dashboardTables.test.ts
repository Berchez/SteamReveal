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
  const html = buildAnalyticsHtml({ entries: entriesJson });
  document.body.innerHTML = html;
  const inner = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!inner) throw new Error('inline <script> has no captured body');
  // eslint-disable-next-line no-eval
  eval(inner[1]);
}

/**
 * Executes the dashboard script with a populated login-funnel block so the
 * funnel panel's DATA path (13 cards, number formatting, rate texts) actually
 * runs — the default 'null' block only ever exercises the "unavailable"
 * early return, and substring tests can't catch a runtime throw here.
 */
function loadDashboardWithFunnel(
  funnel: Record<string, unknown>,
  entriesJson: string = SAMPLE,
) {
  const html = buildAnalyticsHtml({
    entries: entriesJson,
    funnel: JSON.stringify(funnel),
  });
  document.body.innerHTML = html;
  const inner = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!inner) throw new Error('inline <script> has no captured body');
  // eslint-disable-next-line no-eval
  eval(inner[1]);
}

/**
 * Executes the dashboard script with a populated dashboard-stats block so
 * the aggregate panels (stat cards, charts, rankings, cheater section)
 * run their DATA path. Mirrors getDashboardStats/getDashboardHistory
 * shapes — entries carry the capped history window, stats the all-time
 * aggregates.
 */
function loadDashboardWithStats(
  stats: Record<string, unknown> | null,
  entriesJson: string = SAMPLE,
) {
  // Same `<` → `\u003c` escaping production applies in
  // serializeDashboardStats: without it a hostile fixture would break out
  // of the JSON block and the test would prove nothing about the panel.
  const html = buildAnalyticsHtml({
    entries: entriesJson,
    stats:
      stats === null ? 'null' : JSON.stringify(stats).replace(/</g, '\\u003c'),
  });
  document.body.innerHTML = html;
  const inner = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!inner) throw new Error('inline <script> has no captured body');
  // eslint-disable-next-line no-eval
  eval(inner[1]);
}

// Stats fixture mirroring SAMPLE (3 searches: Alice + Bob with cheater
// rows, Carol without). Counts are hand-derived from SAMPLE so the panel
// expectations below pin rendered output, not fixture generation.
const SAMPLE_STATS = {
  summary: {
    totalSearches: 3,
    uniqueProfiles: 3,
    uniqueFriends: 1,
    totalFriends: 1,
    privateListSearches: 0,
    gcMatches: 0,
    avgDurationMs: null,
  },
  searchTimestamps: [
    '2026-09-01T10:00:00.000Z',
    '2026-09-02T10:00:00.000Z',
    '2026-09-03T10:00:00.000Z',
  ],
  localeCounts: { unknown: 3 },
  browserLangCounts: { unknown: 3 },
  deviceCounts: { unknown: 3 },
  countryCounts: { unknown: 3 },
  cheaterRows: [
    {
      searchedAt: '2026-09-01T10:00:00.000Z',
      steamId: '76561198000000001',
      nickname: 'Alice',
      gcName: null,
      countryCode: null,
      steamUrl: null,
      friendCount: 1,
      score: 0.2,
      bannedFriendsCount: 0,
      computedAt: '2026-09-01T11:00:00.000Z',
    },
    {
      searchedAt: '2026-09-02T10:00:00.000Z',
      steamId: '76561198000000002',
      nickname: 'Bob',
      gcName: null,
      countryCode: null,
      steamUrl: null,
      friendCount: 0,
      score: 0.7,
      bannedFriendsCount: 3,
      computedAt: '2026-09-02T11:00:00.000Z',
    },
  ],
  games: [],
  totalProfilesForGames: 3,
  csActiveCount: 0,
  locations: [],
  topProfiles: [
    {
      steamId: '76561198000000001',
      nickname: 'Alice',
      gcName: null,
      countryCode: null,
      count: 1,
    },
    {
      steamId: '76561198000000002',
      nickname: 'Bob',
      gcName: null,
      countryCode: null,
      count: 1,
    },
    {
      steamId: '76561198000000003',
      nickname: 'Carol',
      gcName: null,
      countryCode: null,
      count: 1,
    },
  ],
  topFriends: [
    {
      steamId: '76561198000000009',
      nickname: 'Zed',
      gcName: null,
      countryCode: null,
      count: 1,
    },
  ],
  generatedAt: '2026-09-24T00:00:00.000Z',
};

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

/**
 * Executes the dashboard script with a populated modal-stats block so the
 * three modal sections' DATA path actually runs — the default 'null' block
 * only ever exercises the "unavailable" early return.
 */
function loadDashboardWithModals(
  modals: Record<string, unknown> | null,
  entriesJson: string = SAMPLE,
) {
  const html = buildAnalyticsHtml({
    entries: entriesJson,
    modals: modals === null ? 'null' : JSON.stringify(modals),
  });
  document.body.innerHTML = html;
  const inner = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!inner) throw new Error('inline <script> has no captured body');
  // eslint-disable-next-line no-eval
  eval(inner[1]);
}

function modalSectionTexts(elementId: string): string[] {
  return Array.prototype.map.call(
    document.querySelectorAll(`#${elementId} .stat-card`),
    function (card) {
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
    loadDashboardWithStats(SAMPLE_STATS);
    // Bob 70% > Alice 20%; Carol has no cheater row at all.
    expect(cheaterNicknames()).toEqual(['Bob', 'Alice']);
  });

  it('sorts the cheater table by profile name on header click', () => {
    loadDashboardWithStats(SAMPLE_STATS);
    clickTh('cheater-table', 'profile');
    expect(cheaterNicknames()).toEqual(['Alice', 'Bob']);
    // Second click flips direction.
    clickTh('cheater-table', 'profile');
    expect(cheaterNicknames()).toEqual(['Bob', 'Alice']);
  });

  it('filters cheater rows by nickname or steamId', () => {
    loadDashboardWithStats(SAMPLE_STATS);
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

  function statCardTexts(): string[] {
    return Array.prototype.map.call(
      document.querySelectorAll('#stats .stat-card'),
      function (card) {
        const value = card.querySelector('.value')?.textContent || '';
        const label = card.querySelector('.label')?.textContent || '';
        return `${value} ${label}`.trim();
      },
    ) as string[];
  }

  it('renders stat cards from the stats block (all-time, never the capped window)', () => {
    // SAMPLE entries carry 3 searches but the stats block claims 300:
    // the cards must show the block, proving aggregates don't derive
    // from the capped history window. Fake timers pin "now" to local
    // noon: relative timestamps (now-1h) would fall on yesterday between
    // 00:00 and 01:00 and flake the today card.
    jest.useFakeTimers().setSystemTime(new Date(2026, 8, 30, 12, 0, 0));
    try {
      const now = Date.now();
      const todayIso = new Date(now - 60 * 60 * 1000).toISOString();
      const sixDaysAgoIso = new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString();
      loadDashboardWithStats({
        ...SAMPLE_STATS,
        summary: {
          totalSearches: 300,
          uniqueProfiles: 250,
          uniqueFriends: 400,
          totalFriends: 900,
          privateListSearches: 5,
          gcMatches: 30,
          avgDurationMs: 2500,
        },
        searchTimestamps: [todayIso, todayIso, sixDaysAgoIso],
      });

      expect(statCardTexts()).toEqual([
        '300 Recorded searches',
        '250 Unique searched profiles',
        '400 Unique cataloged friends',
        '3.0 Average friends per search',
        '5 Private-list searches',
        '10.0% GamersClub match rate',
        '2 Searches today',
        '3 Searches in the last 7 days',
        '2.5s Average search duration',
        '45.0% Average cheater probability',
        '45.0% Median cheater probability',
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('announces the history window explicitly', () => {
    loadDashboardWithStats(SAMPLE_STATS);

    const note = document.getElementById('history-window-note');
    if (!note) throw new Error('missing #history-window-note');
    expect(note.textContent).toContain('Showing last 3 of 3 searches');
  });

  it('renders top profiles and friends from the stats block', () => {
    loadDashboardWithStats(SAMPLE_STATS);

    const profiles = document.getElementById('top-profiles')?.textContent || '';
    expect(profiles).toContain('Alice');
    expect(profiles).toContain('Bob');
    expect(profiles).toContain('Carol');
    const friends = document.getElementById('top-friends')?.textContent || '';
    expect(friends).toContain('Zed');
  });

  it('degrades aggregate panels to explicit unavailable states on a null stats block', () => {
    // Failed stats read: no panel may derive plausible-looking numbers
    // from the capped history window, and no panel may throw mid-script
    // (the history table + funnel/modal sections below must still render).
    loadDashboardWithStats(null);

    const statsText =
      document.getElementById('stats')?.textContent || '';
    expect(statsText).toContain('Search stats unavailable');
    for (const id of [
      'chart-by-day',
      'chart-by-hour',
      'chart-locale',
      'chart-country',
      'chart-cheater',
      'chart-locations',
      'chart-games-per-profile',
      'chart-cs-active',
    ]) {
      expect(document.getElementById(id)?.textContent).toContain(
        'Search stats unavailable.',
      );
    }
    expect(
      document.getElementById('top-profiles')?.textContent,
    ).toContain('Search stats unavailable.');
    expect(
      document.getElementById('cheater-empty-msg')?.textContent,
    ).toContain('Search stats unavailable.');
    // History (capped window) still renders from the entries block.
    expect(historyNicknames()).toEqual(['Carol', 'Bob', 'Alice']);
  });

  it('executes the funnel panel data path: 13 cards, numbers, rate texts', () => {
    // Also proves escapeHtml is safe on NUMBER values (String() internally)
    // — a throw here would abort the whole IIFE and fail the table tests.
    loadDashboardWithFunnel({
      ctaEvents: 300,
      ctaSessions: 250,
      callbackSessions: 200,
      steamAbandonSessions: 50,
      waitingSessions: 120,
      waitingLeakSessions: 118,
      completions: 3,
      completedSessions: 2,
      unattributedCompletions: 1,
      conversionRate: 0.8,
      popup: {
        popupShown: 20,
        popupShownSessions: 15,
        popupClicks: 5,
        popupClickSessions: 4,
        popupAttributedSignins: 1,
        popupConversionRate: 25,
      },
      generatedAt: '2026-09-24T00:00:00.000Z',
    });

    expect(funnelCardTexts()).toEqual([
      '300 Sign-in clicks',
      '250 Clicking sessions',
      '200 Returned from Steam',
      '50 Left at Steam',
      '120 Entered waiting room',
      '118 Waiting-room leak',
      '2 Logged-in sessions',
      '1 Unattributed logins',
      '0.8% Click → login conversion',
      '20 Popup shown',
      '5 Popup sign-in clicks',
      '1 Popup-attributed logins',
      '25.0% Popup → login conversion',
    ]);

    // The rest of the dashboard still rendered after the funnel section.
    expect(historyNicknames()).toEqual(['Carol', 'Bob', 'Alice']);
  });

  it('renders the funnel panel with a null rate (—, never 0.0% or NaN)', () => {
    loadDashboardWithFunnel({
      ctaEvents: 0,
      ctaSessions: 0,
      callbackSessions: 0,
      steamAbandonSessions: 0,
      waitingSessions: 0,
      waitingLeakSessions: 0,
      completions: 0,
      completedSessions: 0,
      unattributedCompletions: 0,
      conversionRate: null,
      generatedAt: '2026-09-24T00:00:00.000Z',
    });

    expect(funnelCardTexts()).toContain('— Click → login conversion');
  });

  it('renders missing mid-step keys as 0 (old-shape JSON never breaks the panel)', () => {
    // The num() guard coerces anything non-numeric to 0 — pin it so a
    // future refactor can't throw on a block shaped before 017. The
    // popup half has its own '|| {}' guard, so a block without popup
    // renders its four cards as zeros (and '—' for its rate) too.
    loadDashboardWithFunnel({
      ctaEvents: 4,
      ctaSessions: 3,
      completions: 1,
      completedSessions: 1,
      unattributedCompletions: 0,
      conversionRate: 33.3,
      generatedAt: '2026-09-24T00:00:00.000Z',
    });

    expect(funnelCardTexts()).toEqual([
      '4 Sign-in clicks',
      '3 Clicking sessions',
      '0 Returned from Steam',
      '0 Left at Steam',
      '0 Entered waiting room',
      '0 Waiting-room leak',
      '1 Logged-in sessions',
      '0 Unattributed logins',
      '33.3% Click → login conversion',
      '0 Popup shown',
      '0 Popup sign-in clicks',
      '0 Popup-attributed logins',
      '— Popup → login conversion',
    ]);
  });

  it('renders the three modal sections with four cards each', () => {
    loadDashboardWithModals({
      sponsor: { shown: 10, ctaClicks: 3, closed: 5, dismissed: 2 },
      support: { shown: 7, ctaClicks: 1, closed: 4, dismissed: 2 },
      loginPrompt: { shown: 12, ctaClicks: 4, closed: 6, dismissed: 1 },
      generatedAt: '2026-09-24T00:00:00.000Z',
    });

    expect(modalSectionTexts('modal-sponsor-stats')).toEqual([
      '10 Shown',
      '3 CTA clicks',
      '5 Closed (X)',
      '2 Never show again',
    ]);
    expect(modalSectionTexts('modal-support-stats')).toEqual([
      '7 Shown',
      '1 CTA clicks',
      '4 Closed (X)',
      '2 Never show again',
    ]);
    expect(modalSectionTexts('modal-login-prompt-stats')).toEqual([
      '12 Shown',
      '4 CTA clicks',
      '6 Closed (X)',
      '1 Never show again',
    ]);
  });

  it('renders modal unavailable states on a null block (failed reads degrade, never throw)', () => {
    loadDashboardWithModals(null);

    expect(modalSectionTexts('modal-sponsor-stats')).toEqual([
      '— SponsorMe unavailable',
    ]);
    expect(modalSectionTexts('modal-support-stats')).toEqual([
      '— SupportMe unavailable',
    ]);
    expect(modalSectionTexts('modal-login-prompt-stats')).toEqual([
      '— Login prompt unavailable',
    ]);
  });

  it('never injects markup from hostile stats strings (nicknames, games, locations, urls)', () => {
    const hostile = '</script><img src=x onerror=alert(1)>';
    loadDashboardWithStats({
      summary: {
        totalSearches: 1,
        uniqueProfiles: 1,
        uniqueFriends: 0,
        totalFriends: 0,
        privateListSearches: 0,
        gcMatches: 0,
        avgDurationMs: null,
      },
      searchTimestamps: [],
      localeCounts: {},
      browserLangCounts: {},
      deviceCounts: {},
      countryCounts: {},
      cheaterRows: [
        {
          searchedAt: '2026-09-30T00:00:00.000Z',
          steamId: '76561198000000001',
          nickname: hostile,
          gcName: null,
          countryCode: null,
          steamUrl: hostile,
          friendCount: 0,
          score: 70,
          bannedFriendsCount: 0,
          computedAt: '2026-09-30T00:01:00.000Z',
        },
      ],
      games: [{ name: hostile, totalHours: 10, profilesCount: 1 }],
      totalProfilesForGames: 1,
      csActiveCount: 0,
      locations: [{ location: `{"cityName":"${hostile}"}`, count: 1 }],
      topProfiles: [
        {
          steamId: '76561198000000001',
          nickname: hostile,
          gcName: null,
          countryCode: null,
          count: 1,
        },
      ],
      topFriends: [],
      generatedAt: '2026-09-24T00:00:00.000Z',
    });

    const html = document.body.innerHTML;
    // Escaped form survives in the JSON block (proves values render, just
    // neutralized at the embed layer).
    expect(html).toContain('\\u003cimg src=x onerror=alert(1)>');
    // No payload string may parse as ELEMENTS in the rendered panels. Note
    // this asserts on the DOM, not on the raw innerHTML string: a hostile
    // value rendered into a *quoted attribute* (e.g. the locations chart's
    // data-label) legally re-serializes with a literal `<` — HTML only
    // escapes &, nbsp and " in attribute values — while staying inert
    // (quoted attribute, never a tag). querySelector proves nothing parsed.
    expect(document.body.querySelector('img')).toBeNull();
    expect(document.getElementById('cheater-body')?.querySelector('img')).toBeNull();
    // The hostile cheater row still renders (score badge + nickname text),
    // just neutralized: the nickname survives as text, never as markup.
    expect(document.getElementById('cheater-body')?.textContent).toContain(
      '</script><img src=x onerror=alert(1)>',
    );
  });

  it('exports CSV with formatted locations and a window-tagged filename', async () => {
    const entriesJson = JSON.stringify([
      {
        id: 's1',
        searchedAt: '2026-09-30T00:00:00.000Z',
        profile: { steamId: '76561198000000001', nickname: 'Alice' },
        friends: [],
        locationGuess: [
          {
            location: {
              cityName: 'Sao Paulo',
              stateName: 'SP',
              countryName: 'Brazil',
            },
            probability: 90,
          },
        ],
      },
    ]);
    loadDashboardWithStats(
      {
        ...SAMPLE_STATS,
        summary: { ...SAMPLE_STATS.summary, totalSearches: 42 },
      },
      entriesJson,
    );

    // jsdom has no URL.createObjectURL: capture the Blob instead of a URL.
    const blobs: Blob[] = [];
    const urlStub = URL as unknown as {
      createObjectURL: (b: Blob) => string;
      revokeObjectURL: (u: string) => void;
    };
    const realCreate = urlStub.createObjectURL;
    const realRevoke = urlStub.revokeObjectURL;
    urlStub.createObjectURL = (b: Blob) => {
      blobs.push(b);
      return 'blob:mock';
    };
    urlStub.revokeObjectURL = () => {};
    // Pure spy (no mockImplementation): the handler's own a.click() must
    // still dispatch, and the anchor is removed right after — intercepting
    // the append is the only way to read its download attribute.
    const appendSpy = jest.spyOn(document.body, 'appendChild');
    try {
      (document.getElementById('export-csv') as HTMLButtonElement).click();
    } finally {
      urlStub.createObjectURL = realCreate;
      urlStub.revokeObjectURL = realRevoke;
    }
    const anchor = appendSpy.mock.calls
      .map((call) => call[0])
      .find((node) => node instanceof HTMLAnchorElement) as
      | HTMLAnchorElement
      | undefined;
    appendSpy.mockRestore();

    expect(blobs).toHaveLength(1);
    // jsdom's Blob has no .text(): read it back through FileReader.
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () =>
        reject(reader.error ?? new Error('FileReader failed'));
      reader.readAsText(blobs[0]);
    });
    // locationGuess[0].location is an OBJECT: raw String(obj) would export
    // "[object Object]" — formatLocation must render the real label.
    expect(text).toContain('Sao Paulo, SP, Brazil');
    expect(text).not.toContain('[object Object]');
    // The file covers the 1-row window of 42 searches — the name says so,
    // so it can never be mistaken for a complete backup.
    expect(anchor?.download).toMatch(
      /^steamreveal-analytics-\d{4}-\d{2}-\d{2}-last1of42\.csv$/,
    );
  });

  it('renders missing modal sections as zeros (stale block never breaks the page)', () => {
    // A block shaped before a modal existed (or with the key dropped)
    // must degrade per-section — one bad section can't kill the panels
    // below it.
    loadDashboardWithModals({
      sponsor: { shown: 5, ctaClicks: 1, closed: 2, dismissed: 0 },
      generatedAt: '2026-09-24T00:00:00.000Z',
    });

    expect(modalSectionTexts('modal-sponsor-stats')).toEqual([
      '5 Shown',
      '1 CTA clicks',
      '2 Closed (X)',
      '0 Never show again',
    ]);
    expect(modalSectionTexts('modal-support-stats')).toEqual([
      '0 Shown',
      '0 CTA clicks',
      '0 Closed (X)',
      '0 Never show again',
    ]);
  });

  it('keeps histogram bins, band legend, outcome labels and outcome sort consistent at band boundaries', () => {
    // Cross-consistency guard for every consumer of cheaterBandIndex (the
    // histogram bins/colors, the band-total legend, cheaterOutcome labels,
    // cheaterOutcomeRank sort key): a boundary edit that touched only some
    // of them would fail here. Scores sit exactly on the cuts (0-1
    // fractions, normalized ×100).
    const boundaryRows = [
      { nick: 'VT20', score: 0.2 },
      { nick: 'IN21', score: 0.21 },
      { nick: 'IC45', score: 0.45 },
      { nick: 'IC58', score: 0.58 },
      { nick: 'SU59', score: 0.59 },
      { nick: 'SU65', score: 0.65 },
      { nick: 'HS66', score: 0.66 },
    ];
    const boundaryEntries = JSON.stringify(
      boundaryRows.map((r, i) => ({
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
    // Cheater panels read the stats block now (entries carry history only):
    // same rows, stats-block shape.
    loadDashboardWithStats(
      {
        summary: {
          totalSearches: 7,
          uniqueProfiles: 7,
          uniqueFriends: 0,
          totalFriends: 0,
          privateListSearches: 0,
          gcMatches: 0,
          avgDurationMs: null,
        },
        searchTimestamps: boundaryRows.map(
          (_, i) => '2026-09-0' + (i + 1) + 'T10:00:00.000Z',
        ),
        localeCounts: {},
        browserLangCounts: {},
        deviceCounts: {},
        countryCounts: {},
        cheaterRows: boundaryRows.map((r, i) => ({
          searchedAt: '2026-09-0' + (i + 1) + 'T10:00:00.000Z',
          steamId: '765611980000000' + (10 + i),
          nickname: r.nick,
          gcName: null,
          countryCode: null,
          steamUrl: null,
          friendCount: 0,
          score: r.score,
          bannedFriendsCount: 0,
          computedAt: '2026-09-0' + (i + 1) + 'T11:00:00.000Z',
        })),
        games: [],
        totalProfilesForGames: 7,
        csActiveCount: 0,
        locations: [],
        topProfiles: [],
        topFriends: [],
        generatedAt: '2026-09-24T00:00:00.000Z',
      },
      boundaryEntries,
    );

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
