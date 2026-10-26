import { ANTI_LOOP_TOKEN_PARAM } from '@/lib/watch/notificationText';

let capturedToken: string | undefined;

const readTokenFromUrl = (): string | undefined => {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return (
    new URLSearchParams(window.location.search).get(ANTI_LOOP_TOKEN_PARAM) ||
    undefined
  );
};

/**
 * Captures the single-use anti-loop token before stripping it from the
 * address bar (a spent token lingering in the URL leaks via the Referer
 * header on every outbound player-page link). Called from a client effect,
 * never during render.
 */
export function captureAntiLoopTokenFromUrl(): void {
  if (typeof window === 'undefined') {
    return;
  }

  const token = readTokenFromUrl();
  if (!token) {
    return;
  }

  capturedToken = token;

  const url = new URL(window.location.href);
  url.searchParams.delete(ANTI_LOOP_TOKEN_PARAM);
  window.history.replaceState(null, '', url.toString());
}

/**
 * Read at analytics-send time. If the capture effect has not run yet, the
 * token is still in the URL; otherwise the captured value survives the strip.
 */
export function getCapturedAntiLoopToken(): string | undefined {
  return capturedToken ?? readTokenFromUrl();
}
