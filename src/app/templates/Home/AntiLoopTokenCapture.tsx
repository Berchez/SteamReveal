'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

import { captureAntiLoopTokenFromUrl } from './antiLoopToken';

/**
 * Isolates useSearchParams() behind its own Suspense boundary so HomeProvider
 * never suspends during ISR prerendering. Captures the single-use token and
 * strips it from the address bar before it can leak through outbound Referers.
 */
export default function AntiLoopTokenCapture() {
  const searchParams = useSearchParams();

  useEffect(() => {
    captureAntiLoopTokenFromUrl();
  }, [searchParams]);

  return null;
}
