import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import SupportMe from './SupportMe';
import { useLocale, useTranslations } from 'next-intl';
import { trackModalEvent } from '@/app/templates/Home/shared/analytics/modalAnalytics';

// Mock the next-intl hooks (SponsorMe precedent: key-echo translator).
jest.mock('next-intl', () => ({
  useLocale: jest.fn(() => 'pt'),
  useTranslations: jest.fn(),
}));

// Modal engagement beacons: assert the (modal, event) contract, never the
// network (the helper itself owns fetch/keepalive, pinned in its own test).
jest.mock('@/app/templates/Home/shared/analytics/modalAnalytics', () => ({
  trackModalEvent: jest.fn(),
}));

describe('SupportMe component', () => {
  const mockOnClose = jest.fn();
  const mockDontAskAgain = jest.fn();

  type TranslationKeys =
    | 'supportTitle'
    | 'supportText'
    | 'myPixKey'
    | 'copy'
    | 'copied'
    | 'openStripe'
    | 'tradeLink'
    | 'sendSkin'
    | 'dontAskAgain';

  beforeEach(() => {
    (useLocale as jest.Mock).mockReturnValue('pt');
    (useTranslations as jest.Mock).mockReturnValue((key: TranslationKeys) => {
      const translations: Record<TranslationKeys, string> = {
        supportTitle: 'Support us',
        supportText: 'Help keep the lights on.',
        myPixKey: 'My PIX key',
        copy: 'Copy',
        copied: 'Copied!',
        openStripe: 'Open Stripe',
        tradeLink: 'Trade link',
        sendSkin: 'Send skin',
        dontAskAgain: "Don't ask again",
      };
      return translations[key];
    });
    document.body.setAttribute('data-country', 'BR');
    // jsdom ships no navigator.clipboard: without this the copy-button
    // click logs a (caught) console.error. The beacon fires before the
    // clipboard attempt by design, so the mock only silences noise.
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    document.body.removeAttribute('data-country');
    jest.clearAllMocks();
  });

  it('renders once locale resolution lands (PIX default in BR)', async () => {
    render(<SupportMe onClose={mockOnClose} dontAskAgain={mockDontAskAgain} />);

    await waitFor(() => {
      expect(screen.getByText('Support us')).toBeInTheDocument();
    });
    expect(screen.getByText('PIX')).toBeInTheDocument();
  });

  it('fires the shown beacon exactly once per display', async () => {
    const { rerender } = render(
      <SupportMe onClose={mockOnClose} dontAskAgain={mockDontAskAgain} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Support us')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(trackModalEvent).toHaveBeenCalledWith('support', 'shown');
    });
    // Re-renders (locale/state churn after display) must not re-fire: the
    // waitFor above passes at the first instant, so only a second assert
    // after churn proves "exactly once".
    rerender(<SupportMe onClose={mockOnClose} dontAskAgain={mockDontAskAgain} />);
    await act(async () => {});
    expect(
      (trackModalEvent as jest.Mock).mock.calls.filter(
        ([, event]) => event === 'shown',
      ),
    ).toHaveLength(1);
  });

  it('fires CTA on donation actions (PIX copy, Stripe link, Steam link)', async () => {
    render(<SupportMe onClose={mockOnClose} dontAskAgain={mockDontAskAgain} />);

    await waitFor(() => {
      expect(screen.getByText('Support us')).toBeInTheDocument();
    });
    (trackModalEvent as jest.Mock).mockClear();

    fireEvent.click(screen.getByText('Copy'));
    expect(trackModalEvent).toHaveBeenCalledWith('support', 'cta_clicked');

    fireEvent.click(screen.getByText('STRIPE'));
    fireEvent.click(screen.getByText('Open Stripe'));
    fireEvent.click(screen.getByText('STEAM'));
    fireEvent.click(screen.getByText('Send skin'));

    const ctaCalls = (trackModalEvent as jest.Mock).mock.calls.filter(
      ([modal, event]) => modal === 'support' && event === 'cta_clicked',
    );
    // copy + stripe link + steam link = 3 (tab switches are not CTAs).
    expect(ctaCalls).toHaveLength(3);
  });

  it('fires closed/dismissed and still calls the parent callbacks', async () => {
    render(<SupportMe onClose={mockOnClose} dontAskAgain={mockDontAskAgain} />);

    await waitFor(() => {
      expect(screen.getByText('Support us')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /×/ }));
    expect(trackModalEvent).toHaveBeenCalledWith('support', 'closed');
    expect(mockOnClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Don't ask again"));
    expect(trackModalEvent).toHaveBeenCalledWith('support', 'dismissed');
    expect(mockDontAskAgain).toHaveBeenCalledTimes(1);
  });
});
