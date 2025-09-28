import { CheaterDataType } from '@/@types/cheaterDataType';
import clearStat from '@/app/api/getCheaterProbability/utils/clearCsStats';
import React from 'react';
import { useTranslations } from 'next-intl';

interface ReportBoxProps {
  color: 'red' | 'yellow' | 'green';
  icon: string;
  title: string;
  description: string;
  positiveReasons?: string[];
  negativeReasons?: string[];
}

function analyzeCheaterData(
  data: CheaterDataType,
  translator: ReturnType<typeof useTranslations<'CheaterReport'>>,
) {
  const { cheaterProbability, featureObject } = data;

  const positiveReasons: string[] = [];
  const negativeReasons: string[] = [];

  const addReason = ({
    value,
    positiveMsg,
    negativeMsg,
    condition,
  }: {
    value: number;
    positiveMsg?: string | (() => string);
    negativeMsg?: string | (() => string);
    condition: (v: number) => boolean;
  }) => {
    if (value === -1) {
      return; // ignore invalid data
    }

    if (condition(value) && positiveMsg) {
      positiveReasons.push(
        typeof positiveMsg === 'function' ? positiveMsg() : positiveMsg,
      );
    } else if (negativeMsg) {
      negativeReasons.push(
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
    condition: (v) => v / 60 >= 300,
  });

  // Inventory
  addReason({
    value: featureObject.inventoryScore,
    positiveMsg: translator('valuableInventory'),
    negativeMsg: translator('lowInventory'),
    condition: (v) => v >= 1,
  });

  // Banned friends
  addReason({
    value: featureObject.bannedFriendsScore,
    positiveMsg: translator('cleanFriends'),
    negativeMsg: translator('bannedFriends'),
    condition: (v) => v === 0,
  });

  // Bad comments
  addReason({
    value: featureObject.badCommentsScore,
    positiveMsg: translator('noBadComments'),
    negativeMsg: translator('badComments'),
    condition: (v) => v === 0,
  });

  // CS Stats
  if (featureObject.csStats) {
    const winrate = parseFloat(clearStat(featureObject.csStats.winrate));
    const kpr = parseFloat(clearStat(featureObject.csStats.killsPerRound));
    const headAcc = parseFloat(clearStat(featureObject.csStats.headAccuracy));

    addReason({
      value: winrate,
      positiveMsg: translator('normalWinrate'),
      negativeMsg: () => translator('highWinrate', { winrate }),
      condition: (v) => v < 50,
    });

    addReason({
      value: kpr,
      negativeMsg: translator('highKillsPerRound'),
      condition: (v) => v < 1,
    });

    addReason({
      value: headAcc,
      negativeMsg: translator('highHeadAccuracy'),
      condition: (v) => v < 30,
    });
  }

  // Final classification
  let status: 'suspect' | 'inconclusive' | 'innocent';
  if (cheaterProbability > 0.6) {
    status = 'suspect';
  } else if (cheaterProbability >= 0.4) {
    status = 'inconclusive';
  } else {
    status = 'innocent';
  }

  return { status, positiveReasons, negativeReasons };
}

const borderMap = {
  red: 'border-red-500',
  yellow: 'border-yellow-500',
  green: 'border-green-500',
};

const textMap = {
  red: 'text-red-400',
  yellow: 'text-yellow-400',
  green: 'text-green-400',
};

function ReportBox({
  color,
  icon,
  title,
  description,
  positiveReasons = [],
  negativeReasons = [],
}: ReportBoxProps) {
  const translator = useTranslations('CheaterReport');

  const glassmorphism =
    'bg-purple-900 rounded-xl bg-clip-padding backdrop-filter backdrop-blur-sm bg-opacity-20 border-2 text-white p-6 mt-8';

  const titleClasses = 'text-2xl font-bold mb-2 flex items-center gap-2';
  const listClasses = 'list-disc pl-6 space-y-1 text-sm text-gray-200';

  return (
    <div className={`${glassmorphism} ${borderMap[color]}`}>
      <h2 className={`${titleClasses} ${textMap[color]}`}>
        {icon} {title}
      </h2>
      <p className="mb-3">{description}</p>

      {positiveReasons.length > 0 && (
        <>
          {negativeReasons.length > 0 && (
            <h3 className="font-semibold mt-3">
              ✅ {translator('positiveFactors')}
            </h3>
          )}
          <ul className={listClasses}>
            {positiveReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}

      {negativeReasons.length > 0 && (
        <>
          {positiveReasons.length > 0 && (
            <h3 className="font-semibold mt-3">
              🚩 {translator('negativeFactors')}
            </h3>
          )}
          <ul className={listClasses}>
            {negativeReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function CheaterReport({ cheaterData }: { cheaterData: CheaterDataType }) {
  const translator = useTranslations('CheaterReport');
  const { status, positiveReasons, negativeReasons } = analyzeCheaterData(
    cheaterData,
    translator,
  );

  switch (status) {
    case 'suspect':
      return (
        <ReportBox
          color="red"
          icon="🚩"
          title={translator('suspectTitle')}
          description={translator('suspectDescription')}
          negativeReasons={negativeReasons}
        />
      );

    case 'inconclusive':
      return (
        <ReportBox
          color="yellow"
          icon="⚠️"
          title={translator('inconclusiveTitle')}
          description={translator('inconclusiveDescription')}
          positiveReasons={positiveReasons}
          negativeReasons={negativeReasons}
        />
      );

    case 'innocent':
    default:
      return (
        <ReportBox
          color="green"
          icon="✅"
          title={translator('innocentTitle')}
          description={translator('innocentDescription')}
          positiveReasons={positiveReasons}
        />
      );
  }
}

export default CheaterReport;
