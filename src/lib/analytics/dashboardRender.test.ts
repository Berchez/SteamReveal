import {
  serializeEntries,
  serializeLoginFunnel,
  serializeWatchStats,
  renderDashboard,
} from './dashboardRender';
import type {
  LoginFunnelStats,
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
  it('stringifies records with pretty-print', () => {
    const out = serializeEntries([makeRecord('Alice')]);
    expect(out).toEqual(expect.stringContaining('"nickname": "Alice"'));
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
    const html = renderDashboard([makeRecord('<img src=x onerror=alert(1)>')]);
    expect(html).toContain('<script type="application/json" id="db">');
    expect(html).toContain('\\u003cimg src=x onerror=alert(1)>');
    // The malicious literal tags from the payload must not survive escaping.
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('</script>alert(1)');
  });

  it('embeds an empty watch block by default (panels render empty states)', () => {
    const html = renderDashboard([]);
    expect(html).toContain('<script type="application/json" id="watch-db">');
    expect(html).toMatch(/id="watch-db">\s*null\s*<\/script>/);
    expect(html).toContain('Watcher locales');
    expect(html).toContain('Bot deliveries per day');
  });

  it('embeds an empty login-funnel block by default (panel renders unavailable)', () => {
    const html = renderDashboard([]);
    expect(html).toContain('<script type="application/json" id="login-funnel-db">');
    expect(html).toMatch(/id="login-funnel-db">\s*null\s*<\/script>/);
    expect(html).toContain('Steam login funnel');
  });

  it('embeds funnel stats when provided', () => {
    const html = renderDashboard(
      [],
      null,
      {
        ctaEvents: 300,
        ctaSessions: 250,
        completions: 1,
        completedSessions: 1,
        unattributedCompletions: 0,
        conversionRate: 0.4,
        generatedAt: '2026-09-24T00:00:00.000Z',
      },
    );
    expect(html).toContain('"ctaEvents": 300');
    expect(html).toContain('Click → login conversion');
  });
});

describe('serializeLoginFunnel', () => {
  const funnel: LoginFunnelStats = {
    ctaEvents: 300,
    ctaSessions: 250,
    completions: 1,
    completedSessions: 1,
    unattributedCompletions: 0,
    conversionRate: 0.4,
    generatedAt: '2026-09-24T00:00:00.000Z',
  };

  it('serializes stats without breaking the script block', () => {
    const out = serializeLoginFunnel(funnel);
    expect(out).not.toContain('</script>');
    expect(out).toContain('"conversionRate": 0.4');
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
    expect(out).toContain('"locale": "pt');
  });

  it('serializes null (failed reads degrade to empty panels)', () => {
    expect(serializeWatchStats(null)).toBe('null');
  });
});
