'use client';

import Image from 'next/image';
import React, { useEffect, useState } from 'react';
import {
  isVideoAllowed,
  type VideoBackgroundConnection,
} from './videoLoadDecision';

type IdleAwareWindow = Window & {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout: number },
  ) => number;
  cancelIdleCallback?: (id: number) => void;
};

const POST_LOAD_IDLE_FALLBACK_MS = 300;

const cancelPending = (win: IdleAwareWindow, pendingId: number | null) => {
  if (pendingId === null) {
    return;
  }
  if (typeof win.cancelIdleCallback === 'function') {
    win.cancelIdleCallback(pendingId);
  } else {
    win.clearTimeout(pendingId);
  }
};

function VideoBackground() {
  const [shouldLoadVideo, setShouldLoadVideo] = useState(false);

  useEffect(() => {
    const win = window as IdleAwareWindow;
    const { connection } = navigator as Navigator & {
      connection?: VideoBackgroundConnection;
    };
    const prefersReducedMotion =
      typeof win.matchMedia === 'function' &&
      win.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Once mounted with autoPlay+muted the browser downloads the ~2.2MB loop
    // regardless of preload="none" — so the only real lever is WHEN the
    // <video> enters the DOM. Never mount it on slow connections / reduced
    // motion (the 35KB poster image stays), and on healthy ones wait for
    // window.load (all CSS/fonts/sub-resources done) before even scheduling
    // idle time — starting as early as the old requestIdleCallback/1200ms
    // path ran raced the critical rendering path for bandwidth.
    if (!isVideoAllowed(connection, prefersReducedMotion)) {
      return undefined;
    }

    let pendingId: number | null = null;

    const startVideo = () => {
      pendingId = null;
      setShouldLoadVideo(true);
    };

    const scheduleAfterLoad = () => {
      if (typeof win.requestIdleCallback === 'function') {
        // `timeout` bounds the wait on a saturated main thread: without it
        // the callback may be deferred indefinitely and the video would never
        // mount. 2000ms keeps it decorative-only (never competes with the
        // critical path) while staying deterministic.
        pendingId = win.requestIdleCallback(startVideo, { timeout: 2000 });
      } else {
        pendingId = win.setTimeout(startVideo, POST_LOAD_IDLE_FALLBACK_MS);
      }
    };

    if (document.readyState === 'complete') {
      scheduleAfterLoad();
      return () => cancelPending(win, pendingId);
    }

    const onLoad = () => {
      win.removeEventListener('load', onLoad);
      scheduleAfterLoad();
    };
    win.addEventListener('load', onLoad);
    return () => {
      win.removeEventListener('load', onLoad);
      cancelPending(win, pendingId);
    };
  }, []);

  if (!shouldLoadVideo && process.env.NODE_ENV === 'development') {
    return (
      <div className="fixed inset-0 z-0 pointer-events-none">
        <Image
          src="/images/background.webp"
          alt="background"
          fill
          priority
          sizes="100vw"
          className="object-cover"
        />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-0 pointer-events-none">
      {shouldLoadVideo ? (
        <video
          loop
          preload="none"
          autoPlay
          muted
          playsInline
          className="object-cover w-screen h-screen brightness-90"
          poster="/images/background.webp"
        >
          <source src="/videos/short-bg.webm" type="video/webm" />
          <source src="/videos/short-bg.mp4" type="video/mp4" />
        </video>
      ) : (
        <Image
          src="/images/background.webp"
          alt="background"
          fill
          sizes="100vw"
          className="object-cover"
        />
      )}
    </div>
  );
}

export default VideoBackground;
