import { useCallback, useRef } from 'react';
import type { MutableRefObject } from 'react';

export interface RunGuard {
  reserveNewRun: () => number;

  /**
   * True if `runId` is still the active run. Accepts `number | null` because
   * callers that read `activeRunRef.current` directly (e.g.
   * getCheaterProbability, which doesn't reserve its own run) get a
   * `number | null` — before any run has started, that's `null`, and
   * `null === null` correctly resolves to "still current" here, matching
   * the original direct-comparison behavior this replaced.
   */
  isCurrentRun: (runId: number | null) => boolean;

  activeRunRef: MutableRefObject<number | null>;
}

export function useRunGuard(): RunGuard {
  const runIdCounterRef = useRef(0);
  const activeRunRef = useRef<number | null>(null);

  const reserveNewRun = useCallback(() => {
    runIdCounterRef.current += 1;
    activeRunRef.current = runIdCounterRef.current;

    return runIdCounterRef.current;
  }, []);

  const isCurrentRun = useCallback(
    (runId: number | null) => activeRunRef.current === runId,
    [],
  );

  return { reserveNewRun, isCurrentRun, activeRunRef };
}
