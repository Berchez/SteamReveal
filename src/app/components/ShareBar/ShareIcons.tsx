import React from 'react';

interface ShareIconProps {
  className?: string;
}

/**
 * Inline SVG brand/action icons for the ShareBar — deliberately NOT a
 * lib (react-icons ships whole-pack CJS barrels with no per-icon
 * files, which dev-mode bundling cannot treeshake: ~3MB of fi/fa/fa6
 * on the player page starved the code-split CheaterReport chunk on
 * slow pipes and broke the throttled-network e2e gate). Seven tiny
 * paths (~2KB total) keep the LCP path lean in every environment.
 * Decorative only: every usage sets aria-hidden, the accessible name
 * always comes from the surrounding control.
 */

const base = (
  viewBox: string,
  filled: boolean,
  className: string | undefined,
  children: React.ReactNode,
) => (
  <svg
    viewBox={viewBox}
    aria-hidden="true"
    focusable="false"
    width="1em"
    height="1em"
    fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth={filled ? 0 : 2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    xmlns="http://www.w3.org/2000/svg"
  >
    {children}
  </svg>
);

/** Classic share glyph (box with up-arrow), used on the trigger. */
export function ShareSquareIcon({ className }: ShareIconProps) {
  return base('0 0 24 24', false, className, (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="12" y1="16" x2="12" y2="8" />
      <polyline points="8 12 12 8 16 12" />
    </>
  ));
}

/** X logo (Font Awesome fa6 path). */
export function XLogoIcon({ className }: ShareIconProps) {
  return base('0 0 512 512', true, className, (
    <path d="M389.2 48h70.6L305.6 224.2 487 464H345L233.7 318.6 106.5 464H35.8L200.7 275.5 26.8 48H172.4L272.9 180.9 389.2 48zM364.4 421.8h39.1L151.1 88h-42L364.4 421.8z" />
  ));
}

/** WhatsApp logo (Font Awesome fa path). */
export function WhatsAppLogoIcon({ className }: ShareIconProps) {
  return base('0 0 448 512', true, className, (
    <path d="M380.9 97.1C339 55.1 283.2 32 223.9 32c-122.4 0-222 99.6-222 222 0 39.1 10.2 77.3 29.6 111L0 480l117.7-30.9c32.4 17.7 68.9 27 106.1 27h.1c122.3 0 224.1-99.6 224.1-222 0-59.3-25.2-115-67.1-157zm-157 341.6c-33.2 0-65.7-8.9-94-25.7l-6.7-4-69.8 18.3L72 359.2l-4.4-7c-18.5-29.4-28.2-63.3-28.2-98.2 0-101.7 82.8-184.5 184.6-184.5 49.3 0 95.6 19.2 130.4 54.1 34.8 34.9 56.2 81.2 56.1 130.5 0 101.8-84.9 184.6-186.6 184.6zm101.2-138.2c-5.5-2.8-32.8-16.2-37.9-18-5.1-1.9-8.8-2.8-12.5 2.8-3.7 5.6-14.3 18-17.6 21.8-3.2 3.7-6.5 4.2-12 1.4-32.6-16.3-54-29.1-75.5-66-5.7-9.8 5.7-9.1 16.3-30.3 1.8-3.7.9-6.9-.5-9.7-1.4-2.8-12.5-30.1-17.1-41.2-4.5-10.8-9.1-9.3-12.5-9.5-3.2-.2-6.9-.2-10.6-.2-3.7 0-9.7 1.4-14.8 6.9-5.1 5.6-19.4 19-19.4 46.3 0 27.3 19.9 53.7 22.6 57.4 2.8 3.7 39.1 59.7 94.8 83.8 35.2 15.2 49 16.5 66.6 13.9 10.7-1.6 32.8-13.4 37.4-26.4 4.6-13 4.6-24.1 3.2-26.4-1.3-2.5-5-3.9-10.5-6.6z" />
  ));
}

/** Telegram logo (Font Awesome fa path). */
export function TelegramLogoIcon({ className }: ShareIconProps) {
  return base('0 0 448 512', true, className, (
    <path d="M446.7 98.6l-67.6 318.8c-5.1 22.5-18.4 28.1-37.3 17.5l-103-75.9-49.7 47.8c-5.5 5.5-10.1 10.1-20.7 10.1l7.4-104.9 190.9-172.5c8.3-7.4-1.8-11.5-12.9-4.1L117.8 284 16.2 252.2c-22.1-6.9-22.5-22.1 4.6-32.7L418.2 66.4c18.4-6.9 34.5 4.1 28.5 32.2z" />
  ));
}

/** Link icon (feather link-2 shape). */
export function LinkIcon({ className }: ShareIconProps) {
  return base('0 0 24 24', false, className, (
    <>
      <path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </>
  ));
}

/** Check icon (feather check shape). */
export function CheckIcon({ className }: ShareIconProps) {
  return base('0 0 24 24', false, className, (
    <polyline points="20 6 9 17 4 12" />
  ));
}

/** Generic share icon (feather share-2 shape), used on the native item. */
export function ShareNodesIcon({ className }: ShareIconProps) {
  return base('0 0 24 24', false, className, (
    <>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </>
  ));
}
