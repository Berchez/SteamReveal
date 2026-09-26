/**
 * AdSense gating — single source of truth for WHERE the ad script may load.
 *
 * The publisher ID is hardcoded in the layout, so every host that serves
 * this code (production, Vercel previews, localhost dev, anyone cloning
 * the public repo, the e2e runner) would otherwise fire ad requests tied
 * to our account. Non-production traffic can never monetize (AdSense only
 * serves on approved domains) but still counts as invalid-traffic surface
 * — requests from automation, dev reloads and preview crawls associated
 * with our pub ID. Gate keeps 100% of the revenue (prod only) and drops
 * 100% of the risk surface.
 */

/** AdSense publisher ID (matches public/ads.txt). */
export const AD_PUBLISHER_ID = 'ca-pub-3301991262958911';

/**
 * Hosts allowed to load ads. One-line change per future custom domain.
 * Deliberately a hostname allowlist (not VERCEL_ENV): self-hosted/Docker
 * deploys don't set Vercel env vars, and the check must stay host-agnostic
 * per repo convention.
 */
export const AD_ALLOWED_HOSTS = ['steam-reveal.vercel.app'];

export interface AdLoadContext {
  /** process.env.NODE_ENV at render time. */
  nodeEnv: string | undefined;
  /** Raw Host header (may include :port, any casing). */
  host: string | null | undefined;
}

/**
 * Split a raw Host header into its hostname, or null when it is malformed.
 * Fail-closed by design: unbracketed IPv6, non-numeric ports and any other
 * shape we do not explicitly understand reject the request. In particular
 * a naive `split(':')[0]` would accept `allowlisted-host:<garbage>` —
 * this must never read as canonical production.
 */
function stripPort(host: string): string | null {
  // Bracketed IPv6 literal with optional :port.
  if (host.startsWith('[')) {
    const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(host);
    return match ? match[1] : null;
  }
  // Bare hostname with optional :port. More than one colon (unbracketed
  // IPv6, garbage) or a non-numeric port rejects.
  const parts = host.split(':');
  if (parts.length > 2) {
    return null;
  }
  if (parts.length === 2 && !/^\d+$/.test(parts[1])) {
    return null;
  }
  return parts[0];
}

/**
 * True only on canonical production: NODE_ENV=production AND an allowlisted
 * hostname. Everything else (dev, preview deploys, e2e, clones, staging)
 * gets no ad script at all — not even an unfilled placeholder.
 */
export function shouldLoadAds({ nodeEnv, host }: AdLoadContext): boolean {
  if (nodeEnv !== 'production') {
    return false;
  }
  if (typeof host !== 'string') {
    return false;
  }
  const hostname = stripPort(host);
  if (hostname === null) {
    return false;
  }
  return AD_ALLOWED_HOSTS.includes(hostname.toLowerCase());
}
