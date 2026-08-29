'use client';

import React, { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from '@/navigation';
import { useLocale } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { SUPPORTED_LOCALES, type SupportedLocale } from '@/locales';
import { useTranslations } from 'next-intl';

const LANGUAGE_NAMES: Record<SupportedLocale, string> = {
  en: 'English',
  pt: 'Português',
  ru: 'Русский',
};

const LANGUAGE_FLAGS: Record<SupportedLocale, string> = {
  en: '🇺🇸',
  pt: '🇧🇷',
  ru: '🇷🇺',
};

const MENU_ID = 'language-switcher-menu';

export default function LanguageSwitcher() {
  const [isOpen, setIsOpen] = useState(false);
  const currentLocale = useLocale() as SupportedLocale;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations('LanguageSwitcher');
  const containerRef = useRef<HTMLDivElement>(null);

  const toggleDropdown = () => {
    setIsOpen(!isOpen);
  };

  const handleLocaleChange = (locale: SupportedLocale) => {
    setIsOpen(false);
    router.replace(
      { pathname, query: Object.fromEntries(searchParams.entries()) },
      { locale },
    );
  };

  // Close on outside click / Escape — without this the dropdown stayed
  // open if the user clicked anywhere else on the page.
  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

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
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={toggleDropdown}
        className="flex items-center gap-1 px-2 py-2 rounded-lg bg-neutral-900 hover:bg-neutral-800 text-white transition-colors duration-200 focus:outline-none ring-2 ring-purple-900 focus:ring-purple-500"
        aria-label={`${LANGUAGE_NAMES[currentLocale]} - ${t('toggleMenu')}`}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-controls={MENU_ID}
      >
        <span className="text-sm">{LANGUAGE_FLAGS[currentLocale]}</span>
        <span className="text-xs font-medium hidden sm:inline">
          {LANGUAGE_NAMES[currentLocale]}
        </span>
        <svg
          className={`w-4 h-4 transition-transform duration-200 ${
            isOpen ? 'rotate-180' : ''
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 14l-7 7m0 0l-7-7m7 7V3"
          />
        </svg>
      </button>

      {isOpen && (
        <div
          id={MENU_ID}
          className="absolute right-0 mt-2 w-48 bg-neutral-900 rounded-lg shadow-lg border border-neutral-800 z-50"
          role="menu"
          aria-label={t('selectLanguage')}
        >
          {SUPPORTED_LOCALES.map((locale) => (
            <button
              key={locale}
              onClick={() => handleLocaleChange(locale)}
              className={`w-full flex items-center gap-3 px-4 py-3 transition-colors duration-150 text-left ${
                currentLocale === locale
                  ? 'bg-purple-600 text-white'
                  : 'text-gray-200 hover:bg-neutral-800'
              } ${locale !== SUPPORTED_LOCALES[SUPPORTED_LOCALES.length - 1] ? 'border-b border-neutral-800' : ''}`}
              role="menuitem"
              aria-current={currentLocale === locale ? 'true' : undefined}
              type="button"
            >
              <span className="text-xl">{LANGUAGE_FLAGS[locale]}</span>
              <span className="font-medium">{LANGUAGE_NAMES[locale]}</span>
              {currentLocale === locale && (
                <svg
                  className="w-4 h-4 ml-auto"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
