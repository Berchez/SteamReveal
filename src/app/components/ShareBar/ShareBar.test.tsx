import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import ShareBar from './ShareBar';
import { useLocale, useTranslations } from 'next-intl';

jest.mock('next-intl', () => ({
  useTranslations: jest.fn(),
  useLocale: jest.fn(),
}));

describe('ShareBar', () => {
  const translations: Record<string, string> = {
    label: 'Share this profile',
    share: 'Share',
    copyLink: 'Copy link',
    copied: 'Copied!',
    nativeShare: 'Share…',
    shareOnX: 'Share on X',
    shareOnWhatsApp: 'Share on WhatsApp',
    shareOnTelegram: 'Share on Telegram',
    shareTextFallback: 'See this Steam analysis on SteamReveal',
  };

  const mockTranslator = (key: string) => translations[key] ?? key;
  const originalNavigator = global.navigator;

  beforeEach(() => {
    (useTranslations as jest.Mock).mockReturnValue(mockTranslator);
    (useLocale as jest.Mock).mockReturnValue('en');
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
      },
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(global, 'navigator', {
      value: originalNavigator,
      configurable: true,
    });
    jest.restoreAllMocks();
  });

  it('renders a single trigger with the menu closed', () => {
    render(<ShareBar steamId="123" nickname="foo" />);
    const trigger = screen.getByRole('button', { name: 'Share' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByRole('menu', { name: 'Share this profile' }),
    ).not.toBeInTheDocument();
  });

  it('opens the popover with intent links on trigger click', () => {
    render(<ShareBar steamId="123" nickname="foo" />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(
      screen.getByRole('menu', { name: 'Share this profile' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Share on X' })).toHaveAttribute(
      'href',
      expect.stringContaining('x.com/intent/post'),
    );
    expect(
      screen.getByRole('menuitem', { name: 'Share on WhatsApp' }),
    ).toHaveAttribute('href', expect.stringContaining('wa.me'));
    expect(
      screen.getByRole('menuitem', { name: 'Share on Telegram' }),
    ).toHaveAttribute('href', expect.stringContaining('t.me/share/url'));
  });

  it('shows Copied! inside the copy item after copying', async () => {
    render(<ShareBar steamId="123" />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
    await waitFor(() => {
      expect(
        screen.getByRole('menuitem', { name: 'Copied!' }),
      ).toBeInTheDocument();
    });
  });

  it('closes on Escape and returns focus to the trigger', () => {
    render(<ShareBar steamId="123" />);
    const trigger = screen.getByRole('button', { name: 'Share' });
    fireEvent.click(trigger);
    expect(
      screen.getByRole('menu', { name: 'Share this profile' }),
    ).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(
      screen.queryByRole('menu', { name: 'Share this profile' }),
    ).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on outside click', () => {
    render(<ShareBar steamId="123" />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(
      screen.getByRole('menu', { name: 'Share this profile' }),
    ).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(
      screen.queryByRole('menu', { name: 'Share this profile' }),
    ).not.toBeInTheDocument();
  });

  it('hides the native share item when navigator.share is missing', () => {
    render(<ShareBar steamId="123" />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(
      screen.queryByRole('menuitem', { name: 'Share…' }),
    ).not.toBeInTheDocument();
  });

  it('shows the native share item when navigator.share exists', () => {
    Object.defineProperty(global, 'navigator', {
      value: {
        ...originalNavigator,
        clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
        share: jest.fn().mockResolvedValue(undefined),
      },
      configurable: true,
    });
    render(<ShareBar steamId="123" />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(
      screen.getByRole('menuitem', { name: 'Share…' }),
    ).toBeInTheDocument();
  });

  it('renders nothing without a steamId', () => {
    const { container } = render(<ShareBar steamId="" />);
    expect(container).toBeEmptyDOMElement();
  });
});
