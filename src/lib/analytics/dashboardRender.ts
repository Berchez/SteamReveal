import { buildAnalyticsHtml } from './dashboardTemplate';
import type { SearchRecord, WatchDashboardData } from './types';

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

/**
 * Same embed escaping as serializeEntries (watch payloads carry steamIds
 * and locale strings — constrained, but the rule is uniform: anything
 * embedded into a <script> block gets it).
 */
export const serializeWatchStats = (
  watch: WatchDashboardData | null,
): string => JSON.stringify(watch, null, 2).replace(/</g, '\\u003c');

/** Renders a full dashboard HTML document from the given records. */
export const renderDashboard = (
  entries: SearchRecord[],
  watch: WatchDashboardData | null = null,
): string =>
  buildAnalyticsHtml(serializeEntries(entries), serializeWatchStats(watch));