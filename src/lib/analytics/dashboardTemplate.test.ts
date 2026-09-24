/**
 * @jest-environment node
 */
import vm from 'node:vm';
import { buildAnalyticsHtml } from './dashboardTemplate';

// Guards the incident class where a hand-edited HEAD/TAIL silently corrupted
// the runtime browser JS (safeProfileLink's /^https?:\/\//i became
// /^https?:///i — a regex + line comment, isSafe always true — and the
// csvSafeCell [=+\-@] class collapsed into a range). Compiling alone is NOT
// enough (/^https?:///i also compiles), so the critical escapes are pinned
// as runtime-string literals below.
const extractInlineScript = (html: string): string => {
  const matches = html.match(/<script>([\s\S]*?)<\/script>/g);
  if (!matches || matches.length !== 1) {
    throw new Error(
      `expected exactly one inline <script>, got ${matches ? matches.length : 0}`,
    );
  }
  const inner = /<script>([\s\S]*?)<\/script>/.exec(matches[0]);
  if (!inner) throw new Error('inline <script> has no captured body');
  return inner[1];
};

describe('inline dashboard script', () => {
  it('compiles as valid JS', () => {
    const html = buildAnalyticsHtml('[]', 'null');
    const script = extractInlineScript(html);
    expect(() => new vm.Script(script)).not.toThrow();
  });

  it('preserves the load-bearing escapes (incident regression guard)', () => {
    const html = buildAnalyticsHtml('[]', 'null');
    const script = extractInlineScript(html);
    // safeProfileLink URL-scheme check — single backslashes in the RUNTIME
    // string (doubled here only because this test file is itself parsed).
    expect(script).toContain('/^https?:\\/\\//i');
    // csvSafeCell formula-guard character class.
    expect(script).toContain('[=+\\-@]');
    // A literal close tag inside the block would end the <script> early.
    expect(script).not.toContain('</script>');
  });

  it('buckets the cheater chart by outcome bands and reports mean + median', () => {
    var entries = JSON.stringify([
      { searchedAt: '2026-09-01T00:00:00.000Z', cheater: { score: 0.2 } },
      { searchedAt: '2026-09-02T00:00:00.000Z', cheater: { score: 0.5 } },
      { searchedAt: '2026-09-03T00:00:00.000Z', cheater: { score: 0.7 } },
    ]);
    var html = buildAnalyticsHtml(entries, 'null');
    var script = extractInlineScript(html);
    expect(script).toContain('Very trusted (<35%)');
    expect(script).toContain('Innocent (35-45%)');
    expect(script).toContain('Inconclusive (45-55%)');
    expect(script).toContain('Suspect (55-65%)');
    expect(script).toContain('Highly suspect (>=65%)');
    expect(script).toContain('Median cheater probability');
    expect(script).toContain('Average cheater probability');
  });

  it('embeds a null watch block by default', () => {
    const html = buildAnalyticsHtml('[]');
    expect(html).toContain('<script type="application/json" id="watch-db">');
    expect(html).toMatch(/id="watch-db">\s*null\s*<\/script>/);
  });
});
