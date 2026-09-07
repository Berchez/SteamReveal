import React from 'react';
import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import VideoBackground from './VideoBackground';

jest.mock('next/image', () => {
  const MockImage = (props: {
    src: string;
    alt: string;
    fill?: boolean;
    priority?: boolean;
    sizes?: string;
    className?: string;
  }) => <img alt={props.alt} src={props.src} />;
  return MockImage;
});

const setReadyState = (value: string) => {
  Object.defineProperty(document, 'readyState', {
    configurable: true,
    value,
  });
};

const defineNavigatorConnection = (value: unknown) => {
  Object.defineProperty(navigator, 'connection', {
    configurable: true,
    value,
  });
};

const fireWindowLoad = () => {
  window.dispatchEvent(new Event('load'));
};

const advanceTimers = (ms = 400) => {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
};

describe('VideoBackground', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(global.console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete (document as { readyState?: unknown }).readyState;
    delete (navigator as { connection?: unknown }).connection;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('renders the poster immediately and mounts the video after window.load + idle timeout', () => {
    setReadyState('loading');

    render(<VideoBackground />);

    expect(screen.getByAltText('background')).toBeInTheDocument();
    expect(document.querySelector('video')).toBeNull();

    fireWindowLoad();
    advanceTimers();

    expect(document.querySelector('video')).toBeInTheDocument();
  });

  it('starts the idle timer right away when the document has already finished loading', () => {
    setReadyState('complete');

    render(<VideoBackground />);

    expect(document.querySelector('video')).toBeNull();

    advanceTimers();

    expect(document.querySelector('video')).toBeInTheDocument();
  });

  it('never mounts the video after being unmounted (listener removed, timer cancelled)', () => {
    setReadyState('complete');

    const { unmount } = render(<VideoBackground />);
    unmount();

    expect(() => advanceTimers()).not.toThrow();
    expect(screen.queryByAltText('background')).not.toBeInTheDocument();
    expect(document.querySelector('video')).toBeNull();
  });

  it('does not react to window.load after being unmounted before it fired', () => {
    setReadyState('loading');

    const { unmount } = render(<VideoBackground />);
    unmount();

    fireWindowLoad();
    expect(() => advanceTimers()).not.toThrow();
    expect(document.querySelector('video')).toBeNull();
  });

  it('stays on the poster on a slow connection even after window.load', () => {
    setReadyState('loading');
    defineNavigatorConnection({ effectiveType: '3g', downlink: 0.8 });

    render(<VideoBackground />);

    fireWindowLoad();
    advanceTimers();

    expect(screen.getByAltText('background')).toBeInTheDocument();
    expect(document.querySelector('video')).toBeNull();
  });

  it('stays on the poster when the user prefers reduced motion', () => {
    setReadyState('loading');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn().mockReturnValue({ matches: true }),
    });

    render(<VideoBackground />);

    fireWindowLoad();
    advanceTimers();

    expect(screen.getByAltText('background')).toBeInTheDocument();
    expect(document.querySelector('video')).toBeNull();
  });
});