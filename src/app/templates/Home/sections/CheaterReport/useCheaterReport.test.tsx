import { renderHook } from '@testing-library/react';
import { useTranslations } from 'next-intl';
import useCheaterReport from './useCheaterReport';

jest.mock('next-intl', () => ({
  useTranslations: jest.fn(),
}));

const mockUseTranslations = useTranslations as jest.Mock;

describe('useCheaterReport — single-entry animation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseTranslations.mockReturnValue((key: string) => key);
  });

  it('animates the data when the report mounts already holding final data (prefetch finished before open)', () => {
    const { result } = renderHook(() =>
      useCheaterReport({
        cheaterData: { cheaterProbability: 0.42, featureObject: {} } as any,
      }),
    );

    expect(result.current.animateData).toBe(true);
  });

  it('does not animate the data when the report mounts without data (skeleton animates instead)', () => {
    const { result } = renderHook(() => useCheaterReport({ cheaterData: undefined }));

    expect(result.current.animateData).toBe(false);
  });

  it('does not flip to animateData=true when data arrives after the skeleton (no double animation)', () => {
    const { result, rerender } = renderHook(
      ({ cheaterData }: any) => useCheaterReport({ cheaterData }),
      {
        initialProps: { cheaterData: undefined } as any,
      },
    );

    expect(result.current.animateData).toBe(false);

    // Data arrives while the report is already mounted (skeleton was shown
    // first). animateData must stay false so the real content renders without
    // a second framer-motion entrance.
    rerender({
      cheaterData: { cheaterProbability: 0.42, featureObject: {} },
    });

    expect(result.current.animateData).toBe(false);
  });
});