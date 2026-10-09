/**
 * Pure share-URL builders (no DOM, no React) so intent links are unit-testable.
 * The player path mirrors usePlayerUrlSync (`/player/:steamId`) prefixed
 * with the locale — keep both in sync if the route ever changes.
 */

export function buildPlayerSharePath(
  locale: string,
  steamId: string,
): string {
  return `/${locale}/player/${encodeURIComponent(steamId)}`;
}

const trimOrigin = (origin: string): string => origin.replace(/\/+$/, '');

export function buildPlayerShareUrl(
  origin: string,
  locale: string,
  steamId: string,
): string {
  return `${trimOrigin(origin)}${buildPlayerSharePath(locale, steamId)}`;
}

export interface ShareIntentLinks {
  x: string;
  whatsApp: string;
  telegram: string;
}

export function buildShareIntentLinks(
  url: string,
  text: string,
): ShareIntentLinks {
  const encodedUrl = encodeURIComponent(url);
  const encodedText = encodeURIComponent(text);
  return {
    x: `https://x.com/intent/post?url=${encodedUrl}&text=${encodedText}`,
    whatsApp: `https://wa.me/?text=${encodedText}%20${encodedUrl}`,
    telegram: `https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`,
  };
}

/**
 * Clipboard write with a textarea+execCommand fallback (insecure contexts /
 * denied permissions). Returns true when the text is believed copied.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard?.writeText
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }
  try {
    if (typeof document === 'undefined') {
      return false;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const docWithExec = document as Document & {
      execCommand?: (command: string) => boolean;
    };
    const ok =
      typeof docWithExec.execCommand === 'function'
        ? docWithExec.execCommand('copy')
        : false;
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
