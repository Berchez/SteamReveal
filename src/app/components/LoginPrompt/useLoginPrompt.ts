import { useCallback, useState } from 'react';

/**
 * Non-blocking login-prompt visibility, mirroring the SupportMe scoring
 * model (not SponsorMe's plain visit counter): heavier product actions
 * earn more points toward the display threshold, because a user who just
 * burned an expensive cheater-probability call has demonstrated more
 * intent than one who idly loaded the home page.
 *
 * Weights live with the CALLERS (useHomeSearch/useHome pass points per
 * action, same as handleShowSupportMe) so new heavy calls can join by
 * adding one call site — this hook only owns the threshold math.
 */
export const LOGIN_PROMPT_THRESHOLD = 10;
export const LOGIN_PROMPT_SCORE_KEY = 'loginPromptScore';
const DISMISS_DEBT = -50;

const readScore = (): number => {
  try {
    const raw = localStorage.getItem(LOGIN_PROMPT_SCORE_KEY);
    const parsed = raw === null ? NaN : parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    // Storage blocked (private mode): never show rather than crash or
    // spam — the prompt is promotion, not product.
    return Number.NEGATIVE_INFINITY;
  }
};

const writeScore = (value: number): void => {
  try {
    localStorage.setItem(LOGIN_PROMPT_SCORE_KEY, value.toString());
  } catch {
    // Best effort (see readScore).
  }
};

// Logged-in gate: a single cached GET /api/watch/status per page
// lifetime (the route never mutates state, so this is a safe read).
// Module-scoped (not state) so no re-render is involved.
//
// Tri-state verdict (P1 review fix): ONLY an explicit 401 means
// "logged out" and releases the popup. Any other non-2xx (429 rate
// limit, 5xx, cold-start error) resolves to 'unknown' and SUPPRESSES —
// the old `loggedInCache = res.ok` treated those as "logged out" and
// cached the wrong verdict for the rest of the page lifetime, showing
// the prompt to logged-in users. Transport failures (throw) suppress
// too: a prompt shown to an already-logged-in user is worse than a
// lost impression, so this gate fails CLOSED everywhere except 401.
//
// The verdict is cached as a PROMISE, not a resolved value: two
// threshold crossings in a row (search +1 then report +3, or StrictMode
// double-effect in dev) share one in-flight fetch instead of firing two.
// Definitive verdicts ('logged-in' / 'logged-out') stick for the page
// lifetime; 'unknown' (429/5xx/transport blip) is DROPPED so the next
// threshold crossing retries — a transient rate-limit must not suppress
// the prompt forever on a long-lived page.
type SessionState = 'logged-in' | 'logged-out' | 'unknown';

let sessionStatePromise: Promise<SessionState> | null = null;

const getSessionState = (): Promise<SessionState> => {
  if (!sessionStatePromise) {
    sessionStatePromise = fetch('/api/watch/status', { method: 'GET' })
      .then((res): SessionState => {
        if (res.status === 401) return 'logged-out';
        return res.ok ? 'logged-in' : 'unknown';
      })
      .catch((): SessionState => 'unknown')
      .then((state): SessionState => {
        if (state === 'unknown') {
          sessionStatePromise = null;
        }
        return state;
      });
  }
  return sessionStatePromise;
};

/**
 * Waiting-room / error suppression: when the URL already carries the
 * login handshake state (?login=waiting — OpenID proven, bot friendship
 * outstanding — or ?auth=error), a "Sign in with Steam" popup on top is
 * nonsense. Suppressed before any fetch so it costs zero requests.
 */
const isSuppressedByLocation = (): boolean => {
  try {
    if (typeof window === 'undefined' || !window.location?.search) {
      return false;
    }
    const params = new URLSearchParams(window.location.search);
    return params.has('login') || params.has('auth');
  } catch {
    return false;
  }
};

/**
 * Test-only seam (same precedent as clearWatchStatusPrefetch): drops the
 * cached session verdict so tests start unpolluted. Production never needs
 * it — login AND logout both reload the page (OAuth redirect / WatchManager
 * reload), which wipes module state, so a cached verdict cannot go stale
 * within a page lifetime.
 */
export const resetLoginPromptSessionCache = (): void => {
  sessionStatePromise = null;
};

const useLoginPrompt = () => {
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);

  const handleShowLoginPrompt = useCallback((points: number) => {
    const current = readScore();
    // Storage blocked (readScore degrades to -Infinity): score nothing,
    // persist nothing ("-Infinity" must never land in localStorage), fetch
    // nothing — the prompt is promotion, not product.
    if (!Number.isFinite(current)) {
      return;
    }
    const updated = current + points;
    writeScore(updated);
    if (updated < LOGIN_PROMPT_THRESHOLD) {
      return;
    }
    // Threshold crossed: confirm logged-out (cached, one fetch per page
    // lifetime) before showing — a login prompt is useless noise for a
    // logged-in user. Fire-and-check (never awaited): the call sites stay
    // synchronous like the SponsorMe/SupportMe ones. Only an explicit 401
    // releases the popup; 429/5xx/transport failures suppress (see the
    // gate above). Suppressed outright inside the login waiting room or
    // the auth-error landing (?login= / ?auth= present).
    if (isSuppressedByLocation()) {
      return;
    }
    getSessionState().then((state) => {
      if (state === 'logged-out') {
        setShowLoginPrompt(true);
      }
    });
  }, []);

  // Plain close: back to zero (re-earn the threshold from scratch).
  const onCloseLoginPrompt = useCallback(() => {
    writeScore(0);
    setShowLoginPrompt(false);
  }, []);

  // "Don't ask again": deep negative debt (same -50 precedent as
  // SupportMe) so casual browsing can't resurface it for a long while —
  // deliberate re-engagement still can, which is the humane middle
  // ground between nagging and a permanent opt-out flag.
  const onDismissLoginPrompt = useCallback(() => {
    writeScore(DISMISS_DEBT);
    setShowLoginPrompt(false);
  }, []);

  return {
    showLoginPrompt,
    handleShowLoginPrompt,
    onCloseLoginPrompt,
    onDismissLoginPrompt,
  };
};

export default useLoginPrompt;
