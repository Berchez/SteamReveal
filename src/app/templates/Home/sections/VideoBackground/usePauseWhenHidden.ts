'use client';

import { RefObject, useEffect } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const prefersReducedMotion = (): boolean => {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
};

/**
 * Keeps a decorative <video> from burning frames nobody can see.
 *
 * Two triggers, one rule: while the document is hidden the loop is paused,
 * and while the visitor asks for reduced motion it stays paused - even when
 * the preference is switched on with the page already open (the CSS
 * counterpart for the gradient is reactive, so the two agree).
 *
 * The initial state is synced on mount: a link opened in a background tab
 * mounts the video while document.hidden is ALREADY true, and autoplay
 * would start the loop with nobody watching (the first visibilitychange
 * would only arrive when the visitor comes back).
 *
 * The play() promise is swallowed on purpose: autoplay can be refused and
 * a pause/play race aborts with an AbortError - neither may surface as an
 * unhandled rejection. play() is called through an optional chain because
 * a stubbed/older implementation can return undefined instead of a promise.
 */
const usePauseWhenHidden = (
  videoRef: RefObject<HTMLVideoElement | null>,
  enabled: boolean,
): void => {
  useEffect(() => {
    if (!enabled) return undefined;

    const video = videoRef.current;
    if (video === null) return undefined;

    const pause = () => {
      video.pause();
    };

    const play = () => {
      video.play()?.catch(() => undefined);
    };

    const onVisibilityChange = () => {
      if (document.hidden || prefersReducedMotion()) {
        pause();
      } else {
        play();
      }
    };

    const onReducedMotionChange = (event: MediaQueryListEvent) => {
      if (event.matches) {
        pause();
      } else if (!document.hidden) {
        play();
      }
    };

    if (document.hidden) {
      pause();
    }

    document.addEventListener('visibilitychange', onVisibilityChange);

    const motionQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia(REDUCED_MOTION_QUERY)
        : null;
    motionQuery?.addEventListener?.('change', onReducedMotionChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      motionQuery?.removeEventListener?.('change', onReducedMotionChange);
    };
  }, [videoRef, enabled]);
};

export default usePauseWhenHidden;
