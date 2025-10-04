export const ReportOutcomes = {
  SUSPECT: 'suspect',
  INCONCLUSIVE: 'inconclusive',
  INNOCENT: 'innocent',
} as const;

export const StatusColors = {
  RED: 'red',
  YELLOW: 'yellow',
  GREEN: 'green',
} as const;

export type StatusColorKey = (typeof StatusColors)[keyof typeof StatusColors];
export type ReportOutcomeKey =
  (typeof ReportOutcomes)[keyof typeof ReportOutcomes];
