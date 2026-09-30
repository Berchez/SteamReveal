import {
  serializeDashboardStats,
  serializeEntries,
  serializeLoginFunnel,
  serializeModalStats,
  serializeWatchStats,
  renderDashboard,
} from './dashboardRender';
import type {
  DashboardStats,
  LoginFunnelStats,
  ModalDashboardStats,
  SearchRecord,
  WatchDashboardData,
} from './types';

const makeRecord = (nickname: string): SearchRecord => ({
  id: '1788564056404-tzx2nt',
  searchedAt: '2026-09-04T20:00:00.000Z',
  profile: { steamId: '76561198000000000', nickname },
  friends: [],
});

describe('serializeEntries', () => {
  it('stringifies records compactly (no pretty-print: payload matters)', () => {
    const out = serializeEntries([makeRecord('Alice')]);
    expect(out).toEqual(expect.stringContaining('"nickname":"Alice"'));
  });

  it('escapes every < as \\u003c so </script> cannot close the block', () => {
    const out = serializeEntries([makeRecord('</script><script>alert(1)</script>')]);
    expect(out).not.toContain('</script>');
    expect(out).toContain('\\u003c/script>');
    expect(out).toContain('\\u003cscript>');
  });

  it('handles an empty list', () => {
    expect(serializeEntries([])).toContain('[]');
  });
});

describe('renderDashboard', () => {
  it('wraps the serialized data in the dashboard shell', () => {
    const html = renderDashboard({ entries: [makeRecord('<img src=x onerror=alert(1)>')] });
    expect(html).toContain('<script type="application/json" id="db">');
    expect(html).toContain('\\u003cimg src=x onerror=alert(1)>');
    // The malicious literal tags from the payload must not survive escaping.
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('</script>alert(1)');
  });

  it('embeds an empty watch block by default (panels render empty states)', () => {
    const html = renderDashboard({ entries: [] });
    expect(html).toContain('<script type="application/json" id="watch-db">');
    expect(html).toMatch(/id="watch-db">\s*null\s*<\/script>/);
    expect(html).toContain('Watcher locales');
    expect(html).toContain('Bot deliveries per day');
  });

  it('embeds an empty login-funnel block by default (panel renders unavailable)', () => {
    const html = renderDashboard({ entries: [] });
    expect(html).toContain('<script type="application/json" id="login-funnel-db">');
    expect(html).toMatch(/id="login-funnel-db">\s*null\s*<\/script>/);
    expect(html).toContain('Steam login funnel');
  });

  it('embeds funnel stats when provided', () => {
    const html = renderDashboard({
      entries: [],
      funnel: {
        ctaEvents: 300,
        ctaSessions: 250,
        callbackSessions: 200,
        steamAbandonSessions: 50,
        waitingSessions: 120,
        waitingLeakSessions: 118,
        completions: 1,
        completedSessions: 1,
        unattributedCompletions: 0,
        conversionRate: 0.4,
        popup: {
          popupShown: 20,
          popupShownSessions: 15,
          popupClicks: 5,
          popupClickSessions: 4,
          popupAttributedSignins: 1,
          popupConversionRate: 25,
        },
        generatedAt: '2026-09-24T00:00:00.000Z',
      },
    });
    expect(html).toContain('"ctaEvents":300');
    expect(html).toContain('Click → login conversion');
    expect(html).toContain('"popupClicks":5');
  });

  it('embeds an empty dashboard-stats block by default (panels render unavailable)', () => {
    const html = renderDashboard({ entries: [] });
    expect(html).toContain('<script type="application/json" id="dashboard-stats-db">');
    expect(html).toMatch(/id="dashboard-stats-db">\s*null\s*<\/script>/);
    expect(html).toContain('Search history');
  });

  it('embeds dashboard stats when provided', () => {
    const html = renderDashboard({
      entries: [],
      stats: {
        summary: {
          totalSearches: 6231,
          uniqueProfiles: 6000,
          uniqueFriends: 9000,
          totalFriends: 84000,
          privateListSearches: 10,
          gcMatches: 20,
          avgDurationMs: 1500,
        },
        searchTimestamps: [],
        localeCounts: {},
        browserLangCounts: {},
        deviceCounts: { desktop: 6000 },
        countryCounts: {},
        cheaterRows: [],
        games: [],
        totalProfilesForGames: 6231,
        csActiveCount: 100,
        locations: [],
        topProfiles: [],
        topFriends: [],
        generatedAt: '2026-09-24T00:00:00.000Z',
      },
    });
    expect(html).toContain('"totalSearches":6231');
    expect(html).toContain('"csActiveCount":100');
  });
});

describe('serializeLoginFunnel', () => {
  const funnel: LoginFunnelStats = {
    ctaEvents: 300,
    ctaSessions: 250,
    callbackSessions: 200,
    steamAbandonSessions: 50,
    waitingSessions: 120,
    waitingLeakSessions: 118,
    completions: 1,
    completedSessions: 1,
    unattributedCompletions: 0,
    conversionRate: 0.4,
    popup: {
      popupShown: 20,
      popupShownSessions: 15,
      popupClicks: 5,
      popupClickSessions: 4,
      popupAttributedSignins: 1,
      popupConversionRate: 25,
    },
    generatedAt: '2026-09-24T00:00:00.000Z',
  };

  it('serializes stats without breaking the script block', () => {
    const out = serializeLoginFunnel(funnel);
    expect(out).not.toContain('</script>');
    expect(out).toContain('"conversionRate":0.4');
  });

  it('carries the mid-step aggregates through to the panel JSON block', () => {
    // The template reads these keys straight off the parsed block — a
    // serializer that whitelisted fields would silently zero the new
    // cards, so the keys are pinned here, not just the values.
    const out = serializeLoginFunnel(funnel);
    for (const key of [
      '"callbackSessions":200',
      '"steamAbandonSessions":50',
      '"waitingSessions":120',
      '"waitingLeakSessions":118',
    ]) {
      expect(out).toContain(key);
    }
  });

  it('serializes null (failed reads degrade to the unavailable panel)', () => {
    expect(serializeLoginFunnel(null)).toBe('null');
  });
});

describe('serializeWatchStats', () => {
  const watch: WatchDashboardData = {
    accounts: [
      {
        createdAt: '2026-09-01T00:00:00.000Z',
        confirmedAt: null,
        locale: 'pt<script>',
        lastLoginAt: null,
      },
    ],
    watched: [],
    events: [],
    liveness: null,
    generatedAt: '2026-09-19T00:00:00.000Z',
  };

  it('escapes < exactly like the entries block (no script breakout)', () => {
    const out = serializeWatchStats(watch);
    expect(out).not.toContain('</script>');
    expect(out).toContain('\\u003cscript>');
    expect(out).toContain('"locale":"pt');
  });

  it('serializes null (failed reads degrade to empty panels)', () => {
    expect(serializeWatchStats(null)).toBe('null');
  });
});

describe('serializeDashboardStats', () => {
  const stats: DashboardStats = {
    summary: {
      totalSearches: 6231,
      uniqueProfiles: 6000,
      uniqueFriends: 9000,
      totalFriends: 84000,
      privateListSearches: 10,
      gcMatches: 20,
      avgDurationMs: 1500,
    },
    searchTimestamps: ['2026-09-30T00:00:13.840Z'],
    localeCounts: { en: 6000 },
    browserLangCounts: {},
    deviceCounts: {},
    countryCounts: {},
    cheaterRows: [],
    games: [{ name: 'Counter-Strike 2', totalHours: 50000, profilesCount: 2000 }],
    totalProfilesForGames: 6231,
    csActiveCount: 100,
    locations: [],
    topProfiles: [],
    topFriends: [],
    generatedAt: '2026-09-24T00:00:00.000Z',
  };

  it('serializes aggregates without breaking the script block', () => {
    const out = serializeDashboardStats(stats);
    expect(out).not.toContain('</script>');
    expect(out).toContain('"totalSearches":6231');
    expect(out).toContain('"totalHours":50000');
  });

  it('escapes hostile third-party strings in stats (nicknames, games, urls)', () => {
    const hostile = '</script><img src=x onerror=alert(1)>';
    const hostileStats: DashboardStats = {
      ...stats,
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
      locations: [{ location: hostile, count: 1 }],
    };
    const out = serializeDashboardStats(hostileStats);
    expect(out).not.toContain('</script>');
    expect(out).not.toContain('<img src=x onerror=alert(1)>');
    expect(out).toContain('\\u003c/script>');
    expect(out).toContain('\\u003cimg src=x onerror=alert(1)>');
  });

  it('serializes null (failed reads degrade to the unavailable panels)', () => {
    expect(serializeDashboardStats(null)).toBe('null');
  });
});

describe('serializeModalStats', () => {
  const modals: ModalDashboardStats = {
    sponsor: { shown: 10, ctaClicks: 3, closed: 5, dismissed: 2 },
    support: { shown: 7, ctaClicks: 1, closed: 4, dismissed: 2 },
    loginPrompt: { shown: 12, ctaClicks: 4, closed: 6, dismissed: 1 },
    generatedAt: '2026-09-24T00:00:00.000Z',
  };

  it('serializes per-modal counts without breaking the script block', () => {
    const out = serializeModalStats(modals);
    expect(out).not.toContain('</script>');
    expect(out).toContain('"ctaClicks":3');
    expect(out).toContain('"dismissed":2');
  });

  it('carries all three sections through to the panel JSON block', () => {
    const out = serializeModalStats(modals);
    for (const key of ['"sponsor":{', '"support":{', '"loginPrompt":{']) {
      expect(out).toContain(key);
    }
  });

  it('serializes null (failed reads degrade to the unavailable sections)', () => {
    expect(serializeModalStats(null)).toBe('null');
  });
});

describe('renderDashboard modal block', () => {
  it('embeds the modal-stats block and section containers', () => {
    const html = renderDashboard({
      entries: [],
      modals: {
        sponsor: { shown: 10, ctaClicks: 3, closed: 5, dismissed: 2 },
        support: { shown: 0, ctaClicks: 0, closed: 0, dismissed: 0 },
        loginPrompt: { shown: 0, ctaClicks: 0, closed: 0, dismissed: 0 },
        generatedAt: '2026-09-24T00:00:00.000Z',
      },
    });
    expect(html).toContain('<script type="application/json" id="modal-stats-db">');
    expect(html).toContain('"ctaClicks":3');
    expect(html).toContain('id="modal-sponsor-stats"');
    expect(html).toContain('id="modal-support-stats"');
    expect(html).toContain('id="modal-login-prompt-stats"');
  });

  it('embeds an empty modal block by default (sections render unavailable)', () => {
    const html = renderDashboard({ entries: [] });
    expect(html).toMatch(/id="modal-stats-db">\s*null\s*<\/script>/);
  });
});
