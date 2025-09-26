import { CheaterDataType } from '@/@types/cheaterDataType';
import { clearStat } from '@/app/api/getCheaterProbability/utils/clearCsStats';
import React from 'react';
import { useTranslations } from 'next-intl';

function analyzeCheaterData(
  data: CheaterDataType,
  translator: ReturnType<typeof useTranslations<'CheaterReport'>>,
) {
  const { cheaterProbability, featureObject } = data;
  const positiveReasons: string[] = [];
  const negativeReasons: string[] = [];

  const {
    playTimeScore,
    inventoryScore,
    bannedFriendsScore,
    badCommentsScore,
  } = featureObject;

  const playTimeInHours = playTimeScore / 60;

  // Playtime
  if (playTimeInHours < 300) {
    negativeReasons.push(translator('lowPlaytime', { hours: playTimeInHours }));
  } else {
    positiveReasons.push(
      translator('highPlaytime', { hours: playTimeInHours }),
    );
  }

  // Inventory
  if (inventoryScore < 1.0) {
    negativeReasons.push(translator('lowInventory'));
  } else {
    positiveReasons.push(translator('valuableInventory'));
  }

  // Banned friends
  if (bannedFriendsScore > 0) {
    negativeReasons.push(translator('bannedFriends'));
  } else {
    positiveReasons.push(translator('cleanFriends'));
  }

  // Bad comments
  if (badCommentsScore > 0) {
    negativeReasons.push(translator('badComments'));
  } else {
    positiveReasons.push(translator('noBadComments'));
  }

  // CS Stats
  const winrate = parseFloat(clearStat(featureObject.csStats.winrate));
  const kpr = parseFloat(clearStat(featureObject.csStats.killsPerRound));
  const headAcc = parseFloat(clearStat(featureObject.csStats.headAccuracy));

  if (winrate > 50) {
    positiveReasons.push(translator('highWinrate', { winrate }));
  } else {
    positiveReasons.push(translator('normalWinrate'));
  }

  if (kpr > 0.7) {
    positiveReasons.push(translator('highKillsPerRound'));
  }

  if (headAcc > 25) {
    positiveReasons.push(translator('highHeadAccuracy'));
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

function CheaterReport({ cheaterData }: { cheaterData: CheaterDataType }) {
  const translator = useTranslations('CheaterReport');

  const { status, positiveReasons, negativeReasons } = analyzeCheaterData(
    cheaterData,
    translator,
  );

  const glassmorphism =
    'bg-purple-900 rounded-xl bg-clip-padding backdrop-filter backdrop-blur-sm bg-opacity-20 border-2 border-gray-100/50 text-white p-6 mt-8';

  const titleClasses = 'text-2xl font-bold mb-2 flex items-center gap-2';
  const listClasses = 'list-disc pl-6 space-y-1 text-sm text-gray-200';

  if (status === 'suspect') {
    return (
      <div className={`${glassmorphism} border-red-500`}>
        <h2 className={`${titleClasses} text-red-400`}>
          🚩 {translator('suspectTitle')}
        </h2>
        <p className="mb-3">{translator('suspectDescription')}</p>
        <ul className={listClasses}>
          {negativeReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (status === 'inconclusive') {
    return (
      <div className={`${glassmorphism} border-yellow-500`}>
        <h2 className={`${titleClasses} text-yellow-400`}>
          ⚠️ {translator('inconclusiveTitle')}
        </h2>
        <p className="mb-3">{translator('inconclusiveDescription')}</p>
        <h3 className="font-semibold mt-3">{translator('positiveFactors')}</h3>
        <ul className={listClasses}>
          {positiveReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <h3 className="font-semibold mt-3">{translator('negativeFactors')}</h3>
        <ul className={listClasses}>
          {negativeReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className={`${glassmorphism} border-green-500`}>
      <h2 className={`${titleClasses} text-green-400`}>
        ✅ {translator('innocentTitle')}
      </h2>
      <p className="mb-3">{translator('innocentDescription')}</p>
      <ul className={listClasses}>
        {positiveReasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

export default CheaterReport;
