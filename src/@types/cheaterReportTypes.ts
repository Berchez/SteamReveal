export const ReportOutcomes = {
  VERY_TRUSTED: 'veryTrusted',
  INNOCENT: 'innocent',
  INCONCLUSIVE: 'inconclusive',
  SUSPECT: 'suspect',
  HIGHLY_SUSPECT: 'highlySuspect',
} as const;

export const StatusColors = {
  DARK_GREEN: 'dark-green',
  GREEN: 'green',
  YELLOW: 'yellow',
  ORANGE: 'orange',
  RED: 'red',
} as const;

export type StatusColorKey = (typeof StatusColors)[keyof typeof StatusColors];
export type ReportOutcomeKey =
  (typeof ReportOutcomes)[keyof typeof ReportOutcomes];
