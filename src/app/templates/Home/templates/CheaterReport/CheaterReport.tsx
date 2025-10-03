import { CheaterDataType } from '@/@types/cheaterDataType';
import React from 'react';
import { motion } from 'framer-motion';
import {
  ReportOutcomeKey,
  ReportOutcomes,
  StatusColorKey,
} from '@/@types/cheaterReportTypes';
import ReportBox from '@/app/components/ReportBox';
import ReportBoxSkeleton from './CheaterReportSkeleton';
import useCheaterReport from './useCheaterReport';

function CheaterReport({
  cheaterData,
  isLoading,
  nickname,
}: {
  cheaterData: CheaterDataType | undefined;
  isLoading: boolean;
  nickname: string;
}) {
  const {
    showLoading,
    config,
    outcome,
    innocenceReasons,
    suspicionReasons,
    translator,
  } = useCheaterReport({ cheaterData, isLoading });

  return (
    <>
      {showLoading && (
        <motion.div
          key="loading"
          initial={{ opacity: 0, y: -30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <ReportBoxSkeleton nickname={nickname} />
        </motion.div>
      )}

      {!isLoading && cheaterData && (
        <div className="mt-8">
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
        </div>
      )}
    </>
  );
}
export default CheaterReport;
