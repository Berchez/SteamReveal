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

  it('renders the cheater histogram with a band-total legend and reports mean + median', () => {
    var entries = JSON.stringify([
      { searchedAt: '2026-09-01T00:00:00.000Z', cheater: { score: 0.2 } },
      { searchedAt: '2026-09-02T00:00:00.000Z', cheater: { score: 0.5 } },
      { searchedAt: '2026-09-03T00:00:00.000Z', cheater: { score: 0.7 } },
    ]);
    var html = buildAnalyticsHtml(entries, 'null');
    var script = extractInlineScript(html);
    // Histogram bins (built at runtime from CHEATER_HISTOGRAM_BIN_WIDTH).
    expect(script).toContain('CHEATER_HISTOGRAM_BIN_WIDTH');
    expect(script).toContain('cheaterBinOf');
    // Band-total legend keeps the five outcome-band labels.
    expect(script).toContain('Very trusted (<=20%)');
    expect(script).toContain('Innocent (20-45%)');
    expect(script).toContain('Inconclusive (45-58%)');
    expect(script).toContain('Suspect (58-65%)');
    expect(script).toContain('Highly suspect (>65%)');
    expect(script).toContain('Median cheater probability');
    expect(script).toContain('Average cheater probability');
  });

  it('renders the granular cheater-reports table shell', () => {
    var html = buildAnalyticsHtml('[]', 'null');
    expect(html).toContain('<h2>Cheater reports</h2>');
    expect(html).toContain('<tbody id="cheater-body"></tbody>');
    expect(html).toContain('>Outcome</th>');
    expect(html).toContain('>Banned friends</th>');
    expect(html).toContain('>Friends analyzed</th>');
    expect(html).toContain('>Computed at</th>');
  });

  it('renders sortable, scrollable tables with a cheater filter', () => {
    var html = buildAnalyticsHtml('[]', 'null');
    expect(html).toContain('id="cheater-filter"');
    expect(html).toContain('class="table-scroll"');
    expect(html).toContain('data-sort="score"');
    expect(html).toContain('data-sort="outcome"');
    expect(html).toContain('data-sort="cheater"');
    expect(html).toContain('data-sort="duration"');
    var script = extractInlineScript(html);
    expect(script).toContain('attachThSort');
    expect(script).toContain('cheater-filter');
    // Load-bearing escapes (same rationale as the safeProfileLink/csvSafeCell
    // pins above): the sort-direction arrows are Unicode escapes inside the
    // CSS content property (in the <style> block, not the <script>). A
    // lone backslash dropped by the template-literal parser would turn
    // \\25B2 into "25B2" as literal text instead of the ▲ glyph.
    expect(html).toContain('\\25B2');
    expect(html).toContain('\\25BC');
  });

  it('embeds a null watch block by default', () => {
    const html = buildAnalyticsHtml('[]');
    expect(html).toContain('<script type="application/json" id="watch-db">');
    expect(html).toMatch(/id="watch-db">\s*null\s*<\/script>/);
  });
});
