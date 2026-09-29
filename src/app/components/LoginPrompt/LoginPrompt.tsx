import { useLocale, useTranslations } from 'next-intl';
import React, { useEffect, useRef } from 'react';
import { usePathname } from '@/navigation';
import resolveLoginNext from '@/lib/watch/loginNext';
import {
  recordLoginPopupCta,
  recordLoginPopupShown,
} from '@/app/templates/Home/shared/analytics/loginFunnel';
import { useModalAnalytics } from '@/app/templates/Home/shared/analytics/useModalAnalytics';

interface LoginPromptProps {
  onClose: () => void;
  dontAskAgain: () => void;
}

function LoginPrompt({ onClose, dontAskAgain }: LoginPromptProps) {
  const translator = useTranslations('LoginPrompt');
  // Reuses the existing `feedback.close` key (present in all 8 locales) so
  // the dismiss label is translated without adding a new i18n key.
  const feedbackTranslator = useTranslations('feedback');
  const locale = useLocale();
  const pathname = usePathname();
  const next = resolveLoginNext(pathname, locale);

  // Impression beacons: exactly once per display. The popup-table beacon
  // (popup→signin attribution) keeps its own ref guard — the shared hook
  // below only guards the modal-table beacon that feeds the dashboard's
  // per-modal engagement section.
  const popupShownFiredRef = useRef(false);
  useEffect(() => {
    if (popupShownFiredRef.current) {
      return;
    }
    popupShownFiredRef.current = true;
    recordLoginPopupShown();
  }, []);

  // Engagement beacons for the modal section (fire-and-forget, never
  // awaited): CTA wraps the sign-in link (the popup-table CTA above still
  // fires too — separate table, separate question), close/dismiss wrap
  // the parent callbacks so the modal still unmounts exactly as before.
  // The hook's handleClose is stable (useCallback), so the Esc listener
  // below depends on it without re-subscribing — and Esc dismissals count
  // as closed too instead of bypassing the beacon.
  const { handleCta, handleClose, handleDismiss } = useModalAnalytics(
    'login_prompt',
    { onClose, dontAskAgain },
  );

  // Esc closes (same affordance as a native dialog; SponsorMe/SupportMe
  // don't have it yet — no shared ModalShell exists to inherit from).
  // Routes through handleClose (not the raw onClose prop) so keyboard
  // dismissals fire the closed beacon like the X button does.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Holding Esc auto-repeats keydown before the unmount lands — one
      // dismissal, one beacon, one onClose call.
      if (event.key === 'Escape' && !event.repeat) {
        handleClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [handleClose]);

  // Benefit keys, rendered identically — mapped (not copy-pasted) so a
  // fourth benefit is one key + one locale line, not a new <li> block.
  const benefitKeys = [
    'benefitWatch',
    'benefitBanAlerts',
    'benefitEarlyAccess',
  ] as const;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/75 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-prompt-title"
        className="flex flex-col relative my-auto w-full max-w-md max-h-[90dvh] overflow-y-auto px-8 pt-9 pb-3 bg-[#1c1c28] border border-purple-400/60 ring-1 ring-purple-500/30 shadow-[0_0_50px_rgba(168,85,247,0.35)] rounded-2xl">
        {/* Top accent bar + ambient glows: same purple family as SponsorMe /
            SupportMe, just one hierarchy level above (they use flat border +
            shadow-lg/xl, this uses gradient bar + glow). Decorative only. */}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-purple-500 via-fuchsia-500 to-indigo-500"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 h-48 w-48 rounded-full bg-purple-600/25 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 right-0 h-56 w-56 rounded-full bg-indigo-600/20 blur-3xl"
        />
        <h2 id="login-prompt-title" className="text-3xl font-extrabold tracking-tight text-center mb-3 bg-gradient-to-r from-purple-200 via-purple-300 to-fuchsia-300 bg-clip-text text-transparent">
          {translator('title')}
        </h2>
        <p className="text-purple-100/90 text-[15px] leading-relaxed text-center mb-5">
          {translator('description')}
        </p>
        <ul className="mb-6 space-y-2 text-sm">
          {benefitKeys.map((key) => (
            <li
              key={key}
              className="flex items-start gap-3 rounded-lg border border-purple-500/20 bg-white/[0.04] px-3 py-2 text-purple-100"
            >
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-purple-600/80 text-xs font-bold text-white shadow-[0_0_10px_rgba(168,85,247,0.7)]"
              >
                ✓
              </span>
              {translator(key)}
            </li>
          ))}
        </ul>
        <div className="flex justify-center">
          <a
            href={`/api/auth/steam/login?next=${encodeURIComponent(next)}`}
            onClick={() => {
              // Fire-and-forget (never awaited, never preventDefaulted):
              // the CTA beacon must not delay the Steam navigation, and the
              // completion pairs server-side via the planted ctx cookie.
              // Deliberately NOT recordLoginCta — that would pollute the
              // navbar CTA metric the funnel panel reports.
              recordLoginPopupCta();
              handleCta();
            }}
            className="px-6 py-3 text-base font-semibold text-white rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 shadow-[0_0_24px_rgba(168,85,247,0.6)] hover:shadow-[0_0_34px_rgba(168,85,247,0.8)] hover:-translate-y-0.5 active:translate-y-0 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1c1c28]"
          >
            {translator('signInButton')}
          </a>
        </div>
        <button
          type="button"
          className="self-center mt-6 text-gray-500 underline cursor-pointer hover:text-gray-400 bg-transparent border-none"
          onClick={handleDismiss}
        >
          {translator('dontAskAgain')}
        </button>
        <button
          onClick={handleClose}
          type="button"
          aria-label={feedbackTranslator('close')}
          className="absolute top-0 right-2 text-purple-300 hover:text-purple-500 md:text-4xl text-3xl"
        >
          &times;
        </button>
      </div>
    </div>
  );
}

export default LoginPrompt;
