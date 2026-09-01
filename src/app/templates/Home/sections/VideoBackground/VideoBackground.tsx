'use client';

import Image from 'next/image';
import React, { useEffect, useState } from 'react';

function VideoBackground() {
  const [shouldLoadVideo, setShouldLoadVideo] = useState(false);

  useEffect(() => {
    type IdleAwareWindow = Window & {
      requestIdleCallback?: (callback: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };

    const win = window as IdleAwareWindow;
    const { connection } = navigator as Navigator & {
      connection?: {
        saveData?: boolean;
        effectiveType?: string;
      };
    };
    const slowNetwork =
      connection?.saveData ||
      ['slow-2g', '2g', '3g'].includes(connection?.effectiveType ?? '');

    if (slowNetwork) {
      setShouldLoadVideo(false);
      return undefined;
    }

    const loadVideo = () => setShouldLoadVideo(true);
    const idleCallback = win.requestIdleCallback;

    if (typeof idleCallback === 'function') {
      const idleId = idleCallback.call(win, loadVideo);
      return () => {
        if (typeof win.cancelIdleCallback === 'function') {
          win.cancelIdleCallback(idleId);
        }
      };
    }

    const timeoutId = win.setTimeout(loadVideo, 1200);
    return () => {
      win.clearTimeout(timeoutId);
    };
  }, []);

  if (!shouldLoadVideo && process.env.NODE_ENV === 'development') {
    return (
      <div className="fixed inset-0 z-0">
        <Image src="/images/background.webp" alt="background" fill priority />
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
