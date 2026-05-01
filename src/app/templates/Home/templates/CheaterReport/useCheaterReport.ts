import { CheaterDataType } from '@/@types/cheaterDataType';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { ReportOutcomeKey, ReportOutcomes } from '@/@types/cheaterReportTypes';
import analyzeCheaterData from './utils';

type useCheaterReportType = {
  isLoading: boolean;
  cheaterData: CheaterDataType | undefined;
};

const useCheaterReport = ({ isLoading, cheaterData }: useCheaterReportType) => {
  const translator = useTranslations('CheaterReport');

  const [showLoading, setShowLoading] = useState(false);
  const wasLoading = useRef(false);

  useEffect(() => {
    // Animation only when changing from false -> true
    if (!wasLoading.current && isLoading) {
      setShowLoading(true);
    } else if (!isLoading) {
      setShowLoading(false);
    }
    wasLoading.current = isLoading;
  }, [isLoading]);

  const { outcome, innocenceReasons, suspicionReasons } = cheaterData
    ? analyzeCheaterData(cheaterData, translator)
    : {
        outcome: ReportOutcomes.INCONCLUSIVE,
        innocenceReasons: [],
        suspicionReasons: [],
      };

  const config = {
    veryTrusted: {
      color: 'dark-green',
      icon: '🛡️',
      title: translator('veryTrustedTitle'),
      description: translator('veryTrustedDescription'),
    },
    innocent: {
      color: 'green',
      icon: '✅',
      title: translator('innocentTitle'),
      description: translator('innocentDescription'),
    },
    inconclusive: {
      color: 'yellow',
      icon: '⚖️',
      title: translator('inconclusiveTitle'),
      description: translator('inconclusiveDescription'),
    },
    suspect: {
      color: 'orange',
      icon: '🔍',
      title: translator('suspectTitle'),
      description: translator('suspectDescription'),
    },
    highlySuspect: {
      color: 'red',
      icon: '🚩',
      title: translator('highlySuspectTitle'),
      description: translator('highlySuspectDescription'),
    },
  }[outcome as ReportOutcomeKey];

  return {
    showLoading,
    config,
    outcome,
    innocenceReasons,
    suspicionReasons,
    translator,
  };
};

export default useCheaterReport;
