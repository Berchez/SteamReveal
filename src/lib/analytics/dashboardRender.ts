import { buildAnalyticsHtml } from './dashboardTemplate';
import type { SearchRecord } from './types';

/**
 * Serializes SearchRecord[] for embedding into the dashboard shell.
 *
 * Escaping every `<` as `\u003c` prevents a malicious nickname/URL from
 * carrying a literal `</script>` into the `<script id="db">` block; the
 * browser's JSON.parse() decodes the escapes back, so the data is unchanged.
 * This mirrors the guard that used to live in the JSON-file store's
 * refreshDashboard().
 */
export const serializeEntries = (entries: SearchRecord[]): string =>
  JSON.stringify(entries, null, 2).replace(/</g, '\\u003c');

/** Renders a full dashboard HTML document from the given records. */
export const renderDashboard = (entries: SearchRecord[]): string =>
  buildAnalyticsHtml(serializeEntries(entries));