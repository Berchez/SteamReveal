import React from 'react';
import { useTranslations } from 'next-intl';
import { ReportOutcomeKey, StatusColorKey } from '@/@types/cheaterReportTypes';

interface ReportBoxProps {
  color: StatusColorKey;
  icon: string;
  title: string;
  description: string;
  outcome: ReportOutcomeKey;
  innocenceReasons?: string[];
  suspicionReasons?: string[];
}

const borderColorClasses = {
  red: 'border-red-500',
  yellow: 'border-yellow-500',
  green: 'border-green-500',
};

const textColorClasses = {
  red: 'text-red-400',
  yellow: 'text-yellow-400',
  green: 'text-green-400',
};

function ReportBox({
  color,
  icon,
  title,
  description,
  innocenceReasons = [],
  suspicionReasons = [],
  outcome,
}: ReportBoxProps) {
  const translator = useTranslations('CheaterReport');

  const containerStyle =
    'bg-purple-900 rounded-xl bg-clip-padding backdrop-filter backdrop-blur-sm bg-opacity-20 border-2 text-white p-6 mt-8';

  const titleClasses = 'text-2xl font-bold mb-2 flex items-center gap-2';
  const listClasses = 'list-disc pl-6 space-y-1 text-sm text-gray-200';

  return (
    <div className={`${containerStyle} ${borderColorClasses[color]}`}>
      <h2 className={`${titleClasses} ${textColorClasses[color]}`}>
        {icon} {title}
      </h2>
      <p className="mb-3">{description}</p>

      {innocenceReasons.length > 0 && (
        <>
          {outcome === 'inconclusive' && (
            <h3 className="font-semibold mt-3">
              ✅ {translator('positiveFactors')}
            </h3>
          )}
          <ul className={listClasses}>
            {innocenceReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}

      {suspicionReasons.length > 0 && (
        <>
          {outcome === 'inconclusive' && (
            <h3 className="font-semibold mt-3">
              🚩 {translator('negativeFactors')}
            </h3>
          )}
          <ul className={listClasses}>
            {suspicionReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export default ReportBox;
