/* eslint-disable @typescript-eslint/no-explicit-any */
import { notFound } from 'next/navigation';
import { getRequestConfig } from 'next-intl/server';
import { SUPPORTED_LOCALES, type SupportedLocale } from './locales';

export default getRequestConfig(async ({ locale }) => {
  const requested = locale as SupportedLocale;
  if (!SUPPORTED_LOCALES.includes(requested)) {
    notFound();
  }

  // Return both `locale` and `messages` to satisfy next-intl expectations.
  const messages = (await import(`../messages/${requested}.json`)).default;

  return {
    locale: requested,
    messages,
  };
});
