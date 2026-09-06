import { serializeEntries, renderDashboard } from './dashboardRender';
import type { SearchRecord } from './types';

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
});