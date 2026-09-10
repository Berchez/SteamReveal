'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { isSteamId64 } from '@/lib/steamId';
import { useWatchStatus } from '@/app/templates/Home/hooks/watch/useWatchStatus';
import {
  clearWatchIdentity,
  getWatchIdentity,
  setWatchIdentity,
} from '@/app/templates/Home/hooks/watch/watchIdentity';

/**
 * Watch status page body (Epic 4, WB-10): the three states from the ticket —
 * no registration (form), pending (accept-the-invite instruction), active
 * (unfriend-to-leave instruction) — driven by the local identity plus the
 * WB-9 polling hook. No login, no session: submitting the form POSTs
 * /api/watch/request and stores the id locally, which is what starts the
 * polling and, later, the welcome toast.
 */
function WatchManager() {
  const translator = useTranslations('Watch');
  // Requester locale travels with the watch request so the bot's welcome
  // message (WB-11) is composed in the user's language, not the default.
  const locale = useLocale();
  const [identity, setIdentity] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [input, setInput] = useState('');
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  // Identity lives in localStorage, which does not exist during SSR — read
  // it post-mount and render nothing until then to avoid a hydration
  // mismatch (server renders empty, client would render stored identity).
  useEffect(() => {
    setIdentity(getWatchIdentity());
    setHydrated(true);
  }, []);

  const { status } = useWatchStatus({
    steamId: identity,
    enabled: identity !== null,
  });

  // A stored identity whose watch is gone server-side (opted out on another
  // device, row never existed): heal back to the registration form instead
  // of showing a stale pending screen forever.
  useEffect(() => {
    if (identity !== null && status === 'none') {
      clearWatchIdentity();
      setIdentity(null);
    }
  }, [identity, status]);

  const handleSubmit = useCallback(async () => {
    // No concurrent submits: the input+button are disabled while requesting,
    // and this guard covers the race where two submits interleave anyway.
    if (requesting) return;
    const value = input.trim();
    if (!isSteamId64(value)) {
      setRequestError(translator('watchErrorInvalid'));
      return;
    }
    setRequesting(true);
    setRequestError(null);
    try {
      const res = await fetch('/api/watch/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steamId: value, locale }),
      });
      if (!res.ok) {
        setRequestError(translator('watchErrorFailed'));
        return;
      }
      // Persist FIRST, then hand over: the polling hook reads identity on
      // the next render, so ordering here is the whole integration.
      setWatchIdentity(value);
      setIdentity(value);
    } catch {
      setRequestError(translator('watchErrorFailed'));
    } finally {
      setRequesting(false);
    }
  }, [input, locale, requesting, translator]);

  const handleRemoveLocal = useCallback(() => {
    clearWatchIdentity();
    setIdentity(null);
  }, []);

  if (!hydrated) {
    return null;
  }

  if (identity === null) {
    return (
      <div className="w-full max-w-xl mx-auto flex flex-col gap-y-6 text-center">
        <h1 className="text-2xl font-bold text-gray-100">
          {translator('watchTitle')}
        </h1>
        <p className="text-gray-300">{translator('watchDescription')}</p>
        <div className="flex flex-col md:flex-row gap-3 items-stretch justify-center">
          <input
            className="flex-1 h-12 px-4 text-white text-sm bg-gray-800/75 border border-gray-500 rounded-full placeholder:text-gray-400 focus:border-blue-500 focus:outline-none disabled:opacity-50"
            placeholder={translator('watchInputPlaceholder')}
            value={input}
            disabled={requesting}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              handleSubmit();
            }}
            aria-label={translator('watchInputPlaceholder')}
          />
          <button
            type="button"
            onClick={() => {
              handleSubmit();
            }}
            disabled={requesting}
            className="h-12 px-6 rounded-full bg-purple-600 hover:bg-purple-700/90 disabled:opacity-50 text-white font-semibold text-sm"
          >
            {translator('watchSubmit')}
          </button>
        </div>
        {requestError !== null && (
          <p role="alert" className="text-red-400 text-sm">
            {requestError}
          </p>
        )}
      </div>
    );
  }

  if (status === 'active') {
    return (
      <div className="w-full max-w-xl mx-auto flex flex-col gap-y-6 text-center">
        <h1 className="text-2xl font-bold text-gray-100">
          {translator('watchActiveTitle')}
        </h1>
        <p className="text-gray-300">{translator('watchActiveHint')}</p>
        <div>
          <button
            type="button"
            onClick={handleRemoveLocal}
            className="h-10 px-5 rounded-full border border-gray-500 text-gray-300 text-sm hover:border-gray-300"
          >
            {translator('watchRemoveLocal')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-xl mx-auto flex flex-col gap-y-6 text-center">
      <h1 className="text-2xl font-bold text-gray-100">
        {translator('watchPendingTitle')}
      </h1>
      <p className="text-gray-300">{translator('watchPendingHint')}</p>
      <div>
        <button
          type="button"
          onClick={handleRemoveLocal}
          className="h-10 px-5 rounded-full border border-gray-500 text-gray-300 text-sm hover:border-gray-300"
        >
          {translator('watchRemoveLocal')}
        </button>
      </div>
    </div>
  );
}

export default WatchManager;
