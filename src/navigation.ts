import { createNavigation } from 'next-intl/navigation';
import { SUPPORTED_LOCALES } from './locales';

export const { Link, redirect, usePathname, useRouter } = createNavigation({
  locales: SUPPORTED_LOCALES,
});
