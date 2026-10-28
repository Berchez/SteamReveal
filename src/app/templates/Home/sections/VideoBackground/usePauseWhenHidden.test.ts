import { renderHook } from '@testing-library/react';

import usePauseWhenHidden from './usePauseWhenHidden';

type MotionListener = (event: MediaQueryListEvent) => void;

const nativeMatchMedia = window.matchMedia;

const setDocumentHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    value: hidden,
  });
};

const createMotionQuery = (initial: boolean) => {
  const listeners = new Set<MotionListener>();
  const query = {
    matches: initial,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: (_type: string, listener: MotionListener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: MotionListener) => {
      listeners.delete(listener);
    },
    dispatchEvent: () => true,
    addListener: () => undefined,
    removeListener: () => undefined,
  };
  return {
    query: query as unknown as MediaQueryList,
    set: (matches: boolean) => {
      query.matches = matches;
      listeners.forEach((listener) =>
        listener({ matches } as MediaQueryListEvent),
      );
    },
    size: () => listeners.size,
  };
};

const makeVideoRef = () => {
  const video = document.createElement('video');
  return { current: video } as React.RefObject<HTMLVideoElement | null>;
};

describe('usePauseWhenHidden', () => {
  let play: jest.SpyInstance;
  let pause: jest.SpyInstance;

  beforeEach(() => {
    play = jest
      .spyOn(window.HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined);
    pause = jest
      .spyOn(window.HTMLMediaElement.prototype, 'pause')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete (document as { hidden?: unknown }).hidden;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: nativeMatchMedia,
    });
  });

  it('does nothing while it is disabled (the video has not mounted yet)', () => {
    const ref = makeVideoRef();

    renderHook(() => usePauseWhenHidden(ref, false));

    expect(pause).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });

  it('pauses right away when the tab is already hidden', () => {
    setDocumentHidden(true);
    const ref = makeVideoRef();

    renderHook(() => usePauseWhenHidden(ref, true));

    expect(pause).toHaveBeenCalledTimes(1);
    expect(play).not.toHaveBeenCalled();
  });

  it('pauses when the tab is hidden and plays again when it comes back', () => {
    const ref = makeVideoRef();
    renderHook(() => usePauseWhenHidden(ref, true));

    setDocumentHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(pause).toHaveBeenCalledTimes(1);
    expect(play).not.toHaveBeenCalled();

    setDocumentHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(play).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('ignores a visibilitychange that arrives before the video mounts', () => {
    const ref = makeVideoRef();
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        usePauseWhenHidden(ref, enabled),
      { initialProps: { enabled: false } },
    );

    setDocumentHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(pause).not.toHaveBeenCalled();

    rerender({ enabled: true });
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('removes its listeners on unmount', () => {
    const ref = makeVideoRef();
    const { unmount } = renderHook(() => usePauseWhenHidden(ref, true));
    unmount();

    setDocumentHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));

    expect(pause).not.toHaveBeenCalled();
  });

  it('swallows a rejected play() instead of leaking an unhandled rejection', () => {
    const ref = makeVideoRef();
    play.mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));
    renderHook(() => usePauseWhenHidden(ref, true));

    setDocumentHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));

    expect(play).toHaveBeenCalledTimes(1);
  });

  it('tolerates a play() implementation that returns undefined', () => {
    const ref = makeVideoRef();
    play.mockReturnValue(undefined);
    renderHook(() => usePauseWhenHidden(ref, true));

    setDocumentHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));

    expect(play).toHaveBeenCalledTimes(1);
  });

  it('pauses when the visitor turns reduced motion on, and resumes when it goes back', () => {
    const motion = createMotionQuery(false);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn(() => motion.query),
    });
    const ref = makeVideoRef();
    renderHook(() => usePauseWhenHidden(ref, true));

    motion.set(true);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(play).not.toHaveBeenCalled();

    motion.set(false);
    expect(play).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('does not resume the loop while the tab is still hidden', () => {
    const motion = createMotionQuery(true);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn(() => motion.query),
    });
    setDocumentHidden(true);
    const ref = makeVideoRef();
    renderHook(() => usePauseWhenHidden(ref, true));

    motion.set(false);

    expect(play).not.toHaveBeenCalled();
  });
});
