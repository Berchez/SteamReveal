import { CheaterDataType } from '@/@types/cheaterDataType';
import { ReportOutcomeKey, ReportOutcomes } from '@/@types/cheaterReportTypes';
import { clearStat } from '@/app/api/getCheaterProbability/utils/utils';
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
    conditionToBeSuspect,
  }: {
    value: number;
    positiveMsg?: string | (() => string);
    negativeMsg?: string | (() => string);
    conditionToBeInnocent: (v: number) => boolean;
    conditionToBeSuspect?: (v: number) => boolean;
  }) => {
    if (
      value === -1 ||
      Number.isNaN(value) ||
      value === undefined ||
      value === null
    ) {
      return; // ignore invalid or hidden data
    }

    if (conditionToBeInnocent(value)) {
      if (positiveMsg) {
        innocenceReasons.push(
          typeof positiveMsg === 'function' ? positiveMsg() : positiveMsg,
        );
      }
    } else if (
      conditionToBeSuspect ? conditionToBeSuspect(value) : negativeMsg
    ) {
      // If conditionToBeSuspect is provided, it must be true to add negativeMsg.
      // If NOT provided, it defaults to the old behavior (adding negativeMsg if not innocent).
      if (negativeMsg) {
        suspicionReasons.push(
          typeof negativeMsg === 'function' ? negativeMsg() : negativeMsg,
        );
      }
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
    positiveMsg: translator('cleanFriends', {
      count: featureObject.analyzedFriendsCount,
    }),
    negativeMsg: translator('bannedFriends'),
    conditionToBeInnocent: (v) => v === 0,
  });

  // Account Age
  if (featureObject.accountAge !== undefined) {
    addReason({
      value: featureObject.accountAge,
      positiveMsg: translator('oldAccount', { age: featureObject.accountAge }),
      negativeMsg: translator('newAccount', { age: featureObject.accountAge }),
      conditionToBeInnocent: (v) => v >= 7,
      conditionToBeSuspect: (v) => v <= 2,
    });
  }

  // Steam Level
  addReason({
    value: featureObject.userLevel,
    positiveMsg: translator('highSteamLevel', {
      level: featureObject.userLevel,
    }),
    negativeMsg: translator('lowSteamLevel', {
      level: featureObject.userLevel,
    }),
    conditionToBeInnocent: (v) => v >= 10,
    conditionToBeSuspect: (v) => v <= 3,
  });

  // Total Games Count
  if (featureObject.totalGamesCount !== undefined) {
    addReason({
      value: featureObject.totalGamesCount,
      positiveMsg: translator('manyGames', {
        count: featureObject.totalGamesCount,
      }),
      negativeMsg: translator('fewGames', {
        count: featureObject.totalGamesCount,
      }),
      conditionToBeInnocent: (v) => v >= 30,
      conditionToBeSuspect: (v) => v <= 3,
    });
  }

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
    const kdRaw = clearStat(featureObject.csStats.kd);

    if (winrateRaw !== undefined) {
      const winrate = parseFloat(winrateRaw);
      addReason({
        value: winrate,
        positiveMsg: translator('normalWinrate'),
        negativeMsg: () => translator('highWinrate', { winrate }),
        conditionToBeInnocent: (v) => v < 55,
      });
    }

    if (kdRaw !== undefined) {
      const kd = parseFloat(kdRaw);

      addReason({
        value: kd,
        positiveMsg: () => translator('normalKD', { kd }),
        negativeMsg: () => translator('highKD', { kd }),
        conditionToBeInnocent: (v) => v <= 1.1,
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
  if (cheaterProbability > 0.8) {
    outcome = ReportOutcomes.HIGHLY_SUSPECT;
  } else if (cheaterProbability > 0.6) {
    outcome = ReportOutcomes.SUSPECT;
  } else if (cheaterProbability >= 0.4) {
    outcome = ReportOutcomes.INCONCLUSIVE;
  } else if (cheaterProbability > 0.2) {
    outcome = ReportOutcomes.INNOCENT;
  } else {
    outcome = ReportOutcomes.VERY_TRUSTED;
  }

  const finalInnocenceReasons =
    outcome === ReportOutcomes.HIGHLY_SUSPECT ? [] : innocenceReasons;
  const finalSuspicionReasons =
    outcome === ReportOutcomes.VERY_TRUSTED ? [] : suspicionReasons;

  return {
    outcome,
    innocenceReasons: finalInnocenceReasons,
    suspicionReasons: finalSuspicionReasons,
  };
};

export default analyzeCheaterData;
