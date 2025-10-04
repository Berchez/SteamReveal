import { CheaterDataType } from '@/@types/cheaterDataType';
import { ReportOutcomeKey, ReportOutcomes } from '@/@types/cheaterReportTypes';
import clearStat from '@/app/api/getCheaterProbability/utils/clearCsStats';
import { useTranslations } from 'next-intl';

const analyzeCheaterData = (
  data: CheaterDataType,
  translator: ReturnType<typeof useTranslations<'CheaterReport'>>,
) => {
  const { cheaterProbability, featureObject } = data;

  const innocenceReasons: string[] = [];
  const suspicionReasons: string[] = [];

  const addReason = ({
    value,
    positiveMsg,
    negativeMsg,
    conditionToBeInnocent,
  }: {
    value: number;
    positiveMsg?: string | (() => string);
    negativeMsg?: string | (() => string);
    conditionToBeInnocent: (v: number) => boolean;
  }) => {
    if (value === -1 || Number.isNaN(value) || !value) {
      return; // ignore invalid data
    }

    if (conditionToBeInnocent(value)) {
      if (positiveMsg) {
        innocenceReasons.push(
          typeof positiveMsg === 'function' ? positiveMsg() : positiveMsg,
        );
      }
    } else if (negativeMsg) {
      suspicionReasons.push(
        typeof negativeMsg === 'function' ? negativeMsg() : negativeMsg,
      );
    }
  };

  // Playtime
  addReason({
    value: featureObject.playTimeScore,
    positiveMsg: () =>
      translator('highPlaytime', {
        hours: (featureObject.playTimeScore / 60).toFixed(1),
      }),
    negativeMsg: () =>
      translator('lowPlaytime', {
        hours: (featureObject.playTimeScore / 60).toFixed(1),
      }),
    conditionToBeInnocent: (v) => v / 60 >= 300,
  });

  // Inventory
  addReason({
    value: featureObject.inventoryScore,
    positiveMsg: translator('valuableInventory'),
    negativeMsg: translator('lowInventory'),
    conditionToBeInnocent: (v) => v >= 1,
  });

  // Banned friends
  addReason({
    value: featureObject.bannedFriendsScore,
    positiveMsg: translator('cleanFriends'),
    negativeMsg: translator('bannedFriends'),
    conditionToBeInnocent: (v) => v === 0,
  });

  // Bad comments
  addReason({
    value: featureObject.badCommentsScore,
    positiveMsg: translator('noBadComments'),
    negativeMsg: translator('badComments'),
    conditionToBeInnocent: (v) => v === 0,
  });

  // CS Stats
  if (featureObject.csStats) {
    const kprRaw = clearStat(featureObject.csStats.killsPerRound);
    const headAccRaw = clearStat(featureObject.csStats.headAccuracy);
    const winrateRaw = clearStat(featureObject.csStats.winrate);

    if (winrateRaw !== undefined) {
      const winrate = parseFloat(winrateRaw);
      addReason({
        value: winrate,
        positiveMsg: translator('normalWinrate'),
        negativeMsg: () => translator('highWinrate', { winrate }),
        conditionToBeInnocent: (v) => v < 50,
      });
    }

    if (kprRaw !== undefined) {
      const kpr = parseFloat(kprRaw);
      addReason({
        value: kpr,
        negativeMsg: translator('highKillsPerRound'),
        conditionToBeInnocent: (v) => v < 1,
      });
    }

    if (headAccRaw !== undefined) {
      const headAcc = parseFloat(headAccRaw);

      addReason({
        value: headAcc,
        negativeMsg: translator('highHeadAccuracy'),
        conditionToBeInnocent: (v) => v < 25,
      });
    }
  }

  // Final classification
  let outcome: ReportOutcomeKey;
  if (cheaterProbability > 0.6) {
    outcome = ReportOutcomes.SUSPECT;
  } else if (cheaterProbability >= 0.4) {
    outcome = ReportOutcomes.INCONCLUSIVE;
  } else {
    outcome = ReportOutcomes.INNOCENT;
  }

  return { outcome, innocenceReasons, suspicionReasons };
};

export default analyzeCheaterData;
