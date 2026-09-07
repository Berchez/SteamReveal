export interface VideoBackgroundConnection {
  saveData?: boolean;
  effectiveType?: string;
  downlink?: number;
}

/**
 * Below this effective downlink the video never loads (stays a poster).
 * 1.4 Mbps is roughly "3g-or-worse"; above it, real 4G/5G/fiber as well as
 * many throttled connections pass through and rely on the post-load deferral
 * in VideoBackground to keep them off the critical path.
 */
export const MIN_DOWNLINK_MBPS = 1.4;

/**
 * Decides whether the background video may EVER autoplay, or whether the
 * element must stay a static poster image for this visit.
 *
 * The video is a ~2.2MB decorative loop that, once mounted with
 * autoPlay+muted, the browser downloads regardless of preload="none" — the
 * ONLY real lever is WHEN (or whether) the <video> gets mounted. This helper
 * is the "whether" half (called once, on mount):
 *
 *  - saveData / throttled effectiveType -> poster forever (cheap, keeps the
 *    visual via the 35KB background.webp you can see in the fallback branch).
 *  - Low downlink: real-world throttled links (and DevTools connection
 *    overrides) report a low downlink while effectiveType still says '4g', so
 *    a string check alone misses them. Treat sub-MIN_DOWNLINK_MBPS as slow
 *    regardless of the label.
 *  - prefers-reduced-motion -> poster forever (accessibility; a looping
 *    background animation is exactly the motion this setting targets).
 *
 * CAVEAT: everything here reads navigator.connection, which only exists in
 * Chromium/WebView/Android and Firefox (behind a flag) — it is absent in
 * Safari and older mobile browsers. There, `connection` is always undefined
 * and this helper returns true; those users rely on the window.load deferral
 * (the "when" half, in VideoBackground) for their bandwidth protection, and
 * that's the fallback that applies everywhere. Worth keeping in mind: a
 * Lighthouse lab run throttles at the CDP network layer WITHOUT touching this
 * API, so the gate doesn't participate in lab scores — the deferral does.
 *
 * The "when" half (window.load + idle) lives in VideoBackground.
 */
export const isVideoAllowed = (
  connection: VideoBackgroundConnection | undefined,
  prefersReducedMotion: boolean,
): boolean => {
  if (prefersReducedMotion) {
    return false;
  }
  if (!connection) {
    return true;
  }
  if (connection.saveData === true) {
    return false;
  }
  if (
    connection.downlink !== undefined &&
    Number.isFinite(connection.downlink) &&
    connection.downlink < MIN_DOWNLINK_MBPS
  ) {
    return false;
  }
  if (['slow-2g', '2g', '3g'].includes(connection.effectiveType ?? '')) {
    return false;
  }
  return true;
};
