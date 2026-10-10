'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import HoverTooltip from '@/app/components/HoverTooltip';
import {
  CheckIcon,
  LinkIcon,
  ShareNodesIcon,
  ShareSquareIcon,
  TelegramLogoIcon,
  WhatsAppLogoIcon,
  XLogoIcon,
} from './ShareIcons';
import {
  buildPlayerSharePath,
  buildPlayerShareUrl,
  buildShareIntentLinks,
  copyTextToClipboard,
} from './shareLinks';

interface ShareBarProps {
  steamId: string;
  nickname?: string;
}

const MENU_ITEM_CLASSNAME =
  'flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-purple-100 transition-colors duration-150 hover:bg-purple-600/20 focus:outline-none focus:bg-purple-600/20 focus-visible:ring-2 focus-visible:ring-purple-500/60';

function ShareBar({ steamId, nickname }: ShareBarProps) {
  const t = useTranslations('Share');
  const locale = useLocale();
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [canNativeShare, setCanNativeShare] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const copyTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    setCanNativeShare(
      typeof navigator !== 'undefined' &&
        typeof (navigator as Navigator & { share?: unknown }).share ===
          'function',
    );
  }, []);

  useEffect(
    () => () => {
      window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  // Close on outside click / Escape + move focus into the menu on open —
  // same contract as LanguageSwitcher, plus focus return to the trigger.
  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    copyButtonRef.current?.focus();

    const handlePointerDown = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  if (!steamId) {
    return null;
  }

  const path = buildPlayerSharePath(locale, steamId);
  const absoluteUrl =
    typeof window !== 'undefined'
      ? buildPlayerShareUrl(window.location.origin, locale, steamId)
      : path;
  const shareText = nickname
    ? t('shareText', { nickname })
    : t('shareTextFallback');
  const intents = buildShareIntentLinks(absoluteUrl, shareText);

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(absoluteUrl);
    if (ok) {
      setCopied(true);
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleNativeShare = async () => {
    try {
      await (
        navigator as Navigator & {
          share: (data: {
            title?: string;
            text?: string;
            url?: string;
          }) => Promise<void>;
        }
      ).share({ text: shareText, url: absoluteUrl });
    } catch {
      // User dismissed the sheet — nothing to report.
    }
  };

  return (
    <div className="relative" ref={containerRef} data-testid="share-bar">
      <span className="group relative inline-flex">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          aria-label={t('share')}
          // No aria-controls: the popover mounts only when open, so the
          // referenced id would dangle while closed. Expanded state
          // alone is the honest disclosure.
          aria-expanded={isOpen}
          className="rounded-full border border-purple-500/50 bg-purple-600/30 p-2.5 text-white transition hover:border-purple-400/70 hover:bg-purple-600/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/70"
        >
        <ShareSquareIcon className="h-4 w-4" />
      </button>
      <HoverTooltip text={t('share')} />
    </span>

      {isOpen && (
        <div
          // Deliberately role="group", NOT role="menu": the ARIA menu
          // pattern obliges arrow-key navigation with roving tabindex,
          // which this popover does not implement — a menu role without
          // it puts screen readers in the wrong interaction mode. A
          // plain group of links/buttons keeps Tab and SR semantics
          // honest with zero extra machinery.
          role="group"
          aria-label={t('label')}
          className="absolute right-0 mt-2 w-56 rounded-xl border border-purple-500/30 bg-[#1c1c28]/95 py-1 shadow-xl backdrop-blur-md z-50"
        >
          <button
            ref={copyButtonRef}
            type="button"
            onClick={handleCopy}
            className={MENU_ITEM_CLASSNAME}
          >
            {copied ? (
              <CheckIcon className="text-green-400" />
            ) : (
              <LinkIcon />
            )}
            {copied ? t('copied') : t('copyLink')}
          </button>
          <a
            href={intents.x}
            target="_blank"
            rel="noopener noreferrer"
            className={MENU_ITEM_CLASSNAME}
          >
            <XLogoIcon />
            {t('shareOnX')}
          </a>
          <a
            href={intents.whatsApp}
            target="_blank"
            rel="noopener noreferrer"
            className={MENU_ITEM_CLASSNAME}
          >
            <WhatsAppLogoIcon />
            {t('shareOnWhatsApp')}
          </a>
          <a
            href={intents.telegram}
            target="_blank"
            rel="noopener noreferrer"
            className={MENU_ITEM_CLASSNAME}
          >
            <TelegramLogoIcon />
            {t('shareOnTelegram')}
          </a>
          {canNativeShare && (
            <button
              type="button"
              onClick={handleNativeShare}
              className={MENU_ITEM_CLASSNAME}
            >
              <ShareNodesIcon />
              {t('nativeShare')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default ShareBar;
