import { CheaterDataType } from '@/@types/cheaterDataType';
import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ReportOutcomeKey,
  ReportOutcomes,
  StatusColorKey,
} from '@/@types/cheaterReportTypes';
import ReportBox from '@/app/components/ReportBox';
import ReportBoxSkeleton from './CheaterReportSkeleton';
import useCheaterReport from './useCheaterReport';

// Choke the "Try again" button: the route it re-hits is rate-limited
// (getCheaterProbability, 5-req/30s), so letting the user hammer it re-loads
// the exact rate-limited path. Disable the button for this long after each tap
// so a rapid repeat click can't re-queue the same failing request in a tight
// loop. 15s is a deliberate UX compromise: the backend window is 30s, but a
// shorter lock keeps the button responsive while still breaking the spam loop.
const RETRY_COOLDOWN_MS = 15_000;

function CheaterReport({
  cheaterData,
  cheaterError,
  nickname,
  onRetry,
}: {
  cheaterData: CheaterDataType | undefined;
  cheaterError: boolean;
  nickname: string;
  onRetry: () => void;
}) {
  const {
    animateData,
    config,
    outcome,
    innocenceReasons,
    suspicionReasons,
    translator,
  } = useCheaterReport({ cheaterData });

  // Local retry cooldown (presentation only — see RETRY_COOLDOWN_MS). Tracked
  // in a ref so a re-render (e.g. serializers) doesn't reset the window.
  const retryCooldownUntilRef = useRef(0);
  const retryCooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [retryCooldownActive, setRetryCooldownActive] = useState(false);

  // Clear the cooldown timer on unmount so we never call setState on a
  // detached component (the report closes when navigating to another player).
  useEffect(() => {
    const clearTimer = () => {
      if (retryCooldownTimerRef.current) {
        clearTimeout(retryCooldownTimerRef.current);
      }
    };
    return clearTimer;
  }, []);

  const handleRetry = () => {
    const now = Date.now();
    if (now < retryCooldownUntilRef.current) {
      return;
    }
    retryCooldownUntilRef.current = now + RETRY_COOLDOWN_MS;
    setRetryCooldownActive(true);
    onRetry();
    // Lightweight countdown so the button reflects the remaining lockout.
    retryCooldownTimerRef.current = setTimeout(
      () => setRetryCooldownActive(false),
      RETRY_COOLDOWN_MS,
    );
  };

  if (cheaterError && !cheaterData) {
    return (
      <motion.div
        key="error"
        initial={{ opacity: 0, y: -30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="mt-8 rounded-xl border border-red-800 bg-red-950/40 p-6 text-center"
      >
        <p className="text-red-300">{translator('reportFailedToLoad')}</p>
        <button
          type="button"
          onClick={handleRetry}
          disabled={retryCooldownActive}
          className="mt-4 rounded-lg bg-red-600/20 px-4 py-2 text-sm font-semibold text-red-200 transition hover:bg-red-600/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {translator('retry')}
        </button>
      </motion.div>
    );
  }

  return (
    <>
      {!cheaterData && (
        <motion.div
          key="loading"
          initial={{ opacity: 0, y: -30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <ReportBoxSkeleton nickname={nickname} />
        </motion.div>
      )}

      {cheaterData && (
        <motion.div
          key="data"
          className="mt-8"
          initial={animateData ? { opacity: 0, y: -30 } : false}
          animate={animateData ? { opacity: 1, y: 0 } : false}
          transition={{ duration: 0.5 }}
        >
          <h1 className="text-2xl font-bold text-gray-100 ">
            {(() => {
              const text = translator('isUserCheaterCS2', { nickname });
              return text.charAt(0).toUpperCase() + text.slice(1);
            })()}
          </h1>
          <ReportBox
            color={config.color as StatusColorKey}
            icon={config.icon}
            title={config.title}
            description={config.description}
            innocenceReasons={
              outcome !== ReportOutcomes.SUSPECT ? innocenceReasons : []
            }
            suspicionReasons={
              outcome !== ReportOutcomes.INNOCENT ? suspicionReasons : []
            }
            outcome={outcome as ReportOutcomeKey}
          />
        </motion.div>
      )}
    </>
  );
}
export default CheaterReport;
