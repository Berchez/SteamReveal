import { buildAnalyticsHtml } from './dashboardTemplate';
import type {
  DashboardStats,
  LoginFunnelStats,
  ModalDashboardStats,
  SearchRecord,
  WatchDashboardData,
} from './types';

/**
 * Serializes SearchRecord[] for embedding into the dashboard shell.
 *
 * Escaping every `<` as `\u003c` prevents a malicious nickname/URL from
 * carrying a literal `</script>` into the `<script id="db">` block; the
 * browser's JSON.parse() decodes the escapes back, so the data is unchanged.
 * This mirrors the guard that used to live in the JSON-file store's
 * refreshDashboard().
 *
 * Data minimization: searcherSteamId is stripped here — no dashboard panel
 * reads it, and the owner page source must not carry a who-searched-whom
 * graph. (The field stays on SearchRecord for API consumers that need it.)
 *
 * Compact (no pretty-print): the history window ships full friend rows per
 * search, so indentation would cost ~25-35% of payload for zero behavior
 * gain. View-source readability is not worth megabytes on every load.
 */
export const serializeEntries = (entries: SearchRecord[]): string =>
  JSON.stringify(
    entries.map((entry) => {
      // Shallow copy + delete (not rest-spread with an unread sibling:
      // that trips @typescript-eslint/no-unused-vars). The field stays on
      // SearchRecord for API consumers that need it.
      const copy = { ...entry };
      delete copy.searcherSteamId;
      return copy;
    }),
  ).replace(/</g, '\\u003c');

/**
 * Same embed escaping as serializeEntries (watch payloads carry steamIds
 * and locale strings — constrained, but the rule is uniform: anything
 * embedded into a <script> block gets it).
 */
export const serializeWatchStats = (
  watch: WatchDashboardData | null,
): string => JSON.stringify(watch).replace(/</g, '\\u003c');

/**
 * Same embed escaping as serializeEntries (funnel aggregates are counts
 * and a rate — no free text at all — but the rule is uniform: anything
 * embedded into a <script> block gets it).
 */
export const serializeLoginFunnel = (
  funnel: LoginFunnelStats | null,
): string => JSON.stringify(funnel).replace(/</g, '\\u003c');

/**
 * Same embed escaping as serializeEntries (modal aggregates are counts
 * only — no free text at all — but the rule is uniform: anything
 * embedded into a <script> block gets it).
 */
export const serializeModalStats = (
  modals: ModalDashboardStats | null,
): string => JSON.stringify(modals).replace(/</g, '\\u003c');

/**
 * Same embed escaping as serializeEntries (dashboard aggregates carry
 * third-party strings — nicknames, game names, raw location JSON, steam
 * URLs in cheater/top rows — so the escape is load-bearing, not
 * belt-and-braces; compact for the same payload reason as above).
 */
export const serializeDashboardStats = (
  stats: DashboardStats | null,
): string => JSON.stringify(stats).replace(/</g, '\\u003c');

/** Renders a full dashboard HTML document from the given records. */
export const renderDashboard = (input: {
  entries: SearchRecord[];
  watch?: WatchDashboardData | null;
  funnel?: LoginFunnelStats | null;
  modals?: ModalDashboardStats | null;
  stats?: DashboardStats | null;
}): string =>
  buildAnalyticsHtml({
    entries: serializeEntries(input.entries),
    watch: serializeWatchStats(input.watch ?? null),
    funnel: serializeLoginFunnel(input.funnel ?? null),
    modals: serializeModalStats(input.modals ?? null),
    stats: serializeDashboardStats(input.stats ?? null),
  });