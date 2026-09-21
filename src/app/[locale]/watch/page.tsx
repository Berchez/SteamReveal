import { permanentRedirect } from 'next/navigation';

type WatchPageProps = {
  params: { locale: string };
  searchParams: Record<string, string | string[] | undefined>;
};

// Known one-shot toast params (see QueryToast): forwarded so old
// bookmarks/back-button URLs like /watch?auth=error keep their feedback
// instead of landing silently. Anything else is dropped — the legacy page
// takes no other input. `watch=new` is the single-state first-login
// toast; `confirmed` is the legacy bot-link landing.
const FORWARDED_PARAMS = ['confirmed', 'watch', 'auth'] as const;

/**
 * Legacy standalone /watch page: the flow now lives in the navbar avatar
 * (sign-in → dropdown panel → bot-link confirmation). A dedicated page
 * duplicates that surface with zero added value, so the route survives
 * only as a redirect for bookmarks/back-button.
 * Permanent (308): this route is never coming back — clients and search
 * engines should forget it.
 */
function WatchPage({ params, searchParams }: WatchPageProps) {
  const kept = new URLSearchParams();
  FORWARDED_PARAMS.forEach((key) => {
    const value = searchParams[key];
    if (typeof value === 'string' && value !== '') kept.set(key, value);
  });
  const query = kept.size > 0 ? `?${kept.toString()}` : '';
  permanentRedirect(`/${params.locale}/${query}`);
}

export default WatchPage;
