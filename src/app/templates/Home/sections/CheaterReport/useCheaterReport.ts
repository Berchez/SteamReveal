import { CheaterDataType } from '@/@types/cheaterDataType';
import { useTranslations } from 'next-intl';
import { useRef } from 'react';
import { ReportOutcomeKey, ReportOutcomes } from '@/@types/cheaterReportTypes';
import analyzeCheaterData from './utils';

type useCheaterReportType = {
  cheaterData: CheaterDataType | undefined;
};

const useCheaterReport = ({ cheaterData }: useCheaterReportType) => {
  const translator = useTranslations('CheaterReport');

  // Determines whether the report's very first render already had final
  // data (i.e. the prefetch completed before the section opened). In that
  // case the real content is what should animate - and only it. When the
  // section mounts without data instead, the skeleton animates and the
  // later-appearing real data must NOT animate again (no double animation).
  // Captured once per mount via a ref. Whether the "no data" state is backed
  // by an in-flight request or not is irrelevant to visibility: the section
  // shows the skeleton whenever data is absent, so an unexpected early click
  // (before any request started) still yields feedback instead of a blank box.
  const animatedOnFirstRenderRef = useRef<boolean | undefined>(undefined);
  if (animatedOnFirstRenderRef.current === undefined) {
    animatedOnFirstRenderRef.current = !!cheaterData;
  }
  const animateData = animatedOnFirstRenderRef.current;

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
    animateData,
    config,
    outcome,
    innocenceReasons,
    suspicionReasons,
    translator,
  };
};

export default useCheaterReport;
