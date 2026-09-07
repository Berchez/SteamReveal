import { isVideoAllowed } from './videoLoadDecision';

describe('isVideoAllowed', () => {
  it('allows the video by default (no connection info, motion allowed)', () => {
    expect(isVideoAllowed(undefined, false)).toBe(true);
  });

  it('blocks when the user prefers reduced motion', () => {
    expect(isVideoAllowed(undefined, true)).toBe(false);
    expect(isVideoAllowed({ effectiveType: '4g', downlink: 10 }, true)).toBe(
      false,
    );
  });

  it('blocks on saveData', () => {
    expect(isVideoAllowed({ saveData: true }, false)).toBe(false);
    expect(isVideoAllowed({ saveData: false }, false)).toBe(true);
  });

  it('blocks on throttled effectiveTypes (2g/3g/slow-2g)', () => {
    expect(isVideoAllowed({ effectiveType: 'slow-2g' }, false)).toBe(false);
    expect(isVideoAllowed({ effectiveType: '2g' }, false)).toBe(false);
    expect(isVideoAllowed({ effectiveType: '3g' }, false)).toBe(false);
    expect(isVideoAllowed({ effectiveType: '4g' }, false)).toBe(true);
  });

  it('blocks on a low downlink even when effectiveType says 4g (Slow 4G emulation)', () => {
    expect(isVideoAllowed({ effectiveType: '4g', downlink: 0.9 }, false)).toBe(
      false,
    );
    expect(isVideoAllowed({ effectiveType: '4g', downlink: 1.3 }, false)).toBe(
      false,
    );
    expect(isVideoAllowed({ effectiveType: '4g', downlink: 1.5 }, false)).toBe(
      true,
    );
  });

  it('treats a non-finite downlink as unknown (allow), but a 0 downlink as blocked', () => {
    expect(isVideoAllowed({ downlink: NaN }, false)).toBe(true);
    expect(isVideoAllowed({ downlink: Infinity }, false)).toBe(true);
    // A real-world 0 means throttled/offline, not "no measurement".
    expect(isVideoAllowed({ downlink: 0 }, false)).toBe(false);
  });

  it('blocks saveData regardless of effectiveType/downlink', () => {
    expect(
      isVideoAllowed({ saveData: true, effectiveType: '4g', downlink: 10 }, false),
    ).toBe(false);
  });
});
