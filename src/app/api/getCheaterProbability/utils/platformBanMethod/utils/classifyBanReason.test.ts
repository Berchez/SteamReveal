import classifyBanReason, {
  BanClassification,
} from './classifyBanReason';

describe('classifyBanReason', () => {
  const cases: Array<[string | null | undefined, BanClassification]> = [
    ['Usuário banido pelo Gamers Club Anti-Cheat', 'cheat'],
    ['User banned by Gamers Club Anti-Cheat', 'cheat'],
    ['Banned for cheating on FACEIT', 'cheat'],
    ['Wallhack detection', 'cheat'],
    ['Cheating', 'cheat'],
    ['Usuário suspenso por uso de conta secundária ou smurf na Gamers Club', 'smurf'],
    ['Secondary account usage', 'smurf'],
    ['Smurfing', 'smurf'],
    ['Account sharing / smurf', 'smurf'],
    [null, 'other'],
    [undefined, 'other'],
    ['', 'other'],
    ['Some exotic untranslated reason', 'other'],
  ];

  it.each(cases)(
    'classifies %p as %s',
    (reason, expected) => {
      expect(classifyBanReason(reason)).toBe(expected);
    },
  );

  it('prefers cheat over smurf when both keywords appear', () => {
    expect(classifyBanReason('Banned for cheating and smurfing')).toBe('cheat');
  });
});
