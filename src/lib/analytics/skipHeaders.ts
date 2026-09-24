/**
 * Owner-mode skip header for the public analytics write routes — a leaf
 * module with NO runtime dependencies on purpose.
 *
 * It MUST stay import-light: global-nav surfaces (SiteNavSignIn via the
 * login-funnel beacon) import it transitively, and the previous home
 * (homeAnalyticsUtils.ts) dragged axios + steamapi types into the nav's
 * client chunk. Everything this needs is `window`-guarded and dependency
 * free, so both the search-page utils and the nav-side beacon share ONE
 * implementation here without any bundle-weight coupling.
 */

const ANALYTICS_SKIP_PASSWORD_KEY = 'analytics_skip_password';

const getAnalyticsSkipHeaders = ():
  | Record<string, string>
  | undefined => {
  if (typeof window === 'undefined') {
    return undefined;
  }

  try {
    const skipPassword = localStorage.getItem(ANALYTICS_SKIP_PASSWORD_KEY);

    return skipPassword
      ? { 'x-analytics-skip-password': skipPassword }
      : undefined;
  } catch {
    return undefined;
  }
};

export default getAnalyticsSkipHeaders;
