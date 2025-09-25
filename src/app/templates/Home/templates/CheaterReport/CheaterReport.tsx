import { CheaterDataType } from '@/@types/cheaterDataType';
import React from 'react';

function analyzeCheaterData(data: CheaterDataType) {
  const { cheaterProbability, featureObject } = data;
  const reasons: string[] = [];

  // Tempo de jogo
  if (featureObject.playTimeScore < 50000) {
    reasons.push('Pouco tempo de jogo (sinal de pouca experiência)');
  } else {
    reasons.push('Tempo de jogo elevado (experiência acumulada)');
  }

  // Inventário
  if (featureObject.inventoryScore < 1.0) {
    reasons.push('Inventário baixo (itens de valor reduzido)');
  } else {
    reasons.push('Inventário valioso (sinal de jogador estabelecido)');
  }

  // Amigos banidos
  if (featureObject.bannedFriendsScore > 0) {
    reasons.push('Possui amigos banidos no Steam (sinal suspeito)');
  } else {
    reasons.push('Nenhum amigo banido (rede social limpa)');
  }

  // Comentários negativos
  if (featureObject.badCommentsScore > 0) {
    reasons.push('Recebeu comentários negativos (feedback da comunidade)');
  } else {
    reasons.push('Nenhum comentário negativo (boa reputação)');
  }

  // Estatísticas de CS
  const winrate = parseFloat(featureObject.csStats.winrate);
  const kpr = parseFloat(featureObject.csStats.killsPerRound);
  const headAcc = parseFloat(featureObject.csStats.headAccuracy);

  if (winrate > 50) {
    reasons.push('Taxa de vitória acima de 50% (performance alta)');
  } else {
    reasons.push('Taxa de vitória normal');
  }
  if (kpr > 0.7) {
    reasons.push('Muitos kills por rodada (indica habilidade elevada)');
  }
  if (headAcc > 25) {
    reasons.push('Alta precisão na cabeça (indica mira muito treinada)');
  }

  // Classificação final
  let status: 'suspeito' | 'inconclusivo' | 'inocente';
  if (cheaterProbability > 0.6) {
    status = 'suspeito';
  } else if (cheaterProbability >= 0.4) {
    status = 'inconclusivo';
  } else {
    status = 'inocente';
  }
  return { status, reasons };
}

function CheaterReport({ cheaterData }: { cheaterData: CheaterDataType }) {
  const { status, reasons } = analyzeCheaterData(cheaterData);

  const baseClasses =
    'rounded-2xl shadow-md p-6 border transition-all duration-300 mt-8 bg-purple-100';
  const titleClasses = 'text-2xl font-bold mb-2 flex items-center gap-2';
  const listClasses = 'list-disc pl-6 space-y-1 text-sm text-gray-700';

  if (status === 'suspeito') {
    return (
      <div className={`${baseClasses} border-red-400`}>
        <h2 className={`${titleClasses} text-red-700`}>
          🚩 Suspeito de Trapaça!
        </h2>
        <p className="text-gray-800 mb-3">
          Baseado nos dados analisados, este jogador apresenta fatores
          suspeitos:
        </p>
        <ul className={listClasses}>
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (status === 'inconclusivo') {
    return (
      <div className={`${baseClasses} border-yellow-400`}>
        <h2 className={`${titleClasses} text-yellow-700`}>
          ⚠️ Resultado Inconclusivo
        </h2>
        <p className="text-gray-800 mb-3">
          A análise não é definitiva. Alguns fatores apontam para suspeita e
          outros para inocência:
        </p>
        <ul className={listClasses}>
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className={`${baseClasses} border-green-400`}>
      <h2 className={`${titleClasses} text-green-700`}>✅ Parece Inocente</h2>
      <p className="text-gray-800 mb-3">
        Este jogador apresenta sinais de perfil normal/no padrão:
      </p>
      <ul className={listClasses}>
        {reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  );
}

export default CheaterReport;
