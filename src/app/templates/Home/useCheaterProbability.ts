import axios from 'axios';
import { useCallback, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { toast } from 'react-toastify';
import { track } from '@vercel/analytics';
import { CheaterDataType } from '@/@types/cheaterDataType';
import { closeFriendsDataIWant } from '@/@types/closeFriendsDataIWant';
import targetInfoJsonType from '@/@types/targetInfoJsonType';
import { isLoadingType } from '@/@types/isLoadingType';

import { updateCachedSearchById } from './homeCache';

import { getAnalyticsSkipHeaders } from './homeAnalyticsUtils';

import type { RunGuard } from './useRunGuard';

interface UseCheaterProbabilityParams {
  runGuard: RunGuard;
  isLoadingFriendsCards: boolean;
  setIsLoading: Dispatch<SetStateAction<isLoadingType>>;
  targetInfoJson: targetInfoJsonType | undefined;
  closeFriendsJson: closeFriendsDataIWant[] | undefined;
  setCheaterData: Dispatch<SetStateAction<CheaterDataType | undefined>>;
  handleShowSupportMe: (days: number) => void;
  lastSearchIdRef: MutableRefObject<string | null>;
}

/**
 * getCheaterProbability extracted from useHome.ts, with a deliberate
 * behavioral change: the reactive values the function only needs to READ at
 * click time (isLoading.friendsCards, targetInfoJson, closeFriendsJson) come
 * from refs instead of from the closure through useCallback deps — this is
 * what keeps the function's identity stable across searches.
 *
 * IMPORTANT: the refs below are synced by DIRECT ASSIGNMENT during render,
 * not inside a useEffect. This is intentional. useEffect callbacks are
 * scheduled and run asynchronously after commit/paint — there's a real
 * (if narrow) window where a ref updated via useEffect could still hold a
 * stale value if something invoked getCheaterProbability before that effect
 * had a chance to run. Assigning `ref.current = value` directly in the
 * render body has no such window: it happens synchronously as part of the
 * render that produces the value, so by the time this render commits and
 * the user can trigger any callback, the ref is guaranteed current. This is
 * safe specifically because we never READ these refs during render — only
 * inside the async callback below.
 *
 * This matters because getCheaterProbability is included in the
 * actionsValue useMemo in HomeProvider.tsx. Every time its identity changed
 * (i.e. on every search), actionsValue ALSO changed — causing any consumer
 * of HomeActionsContext to re-render, even consumers unrelated to the
 * cheater report. That's exactly the re-render the Data/Actions separation
 * was meant to prevent.
 */
const useCheaterProbability = ({
  runGuard,
  isLoadingFriendsCards,
  setIsLoading,
  targetInfoJson,
  closeFriendsJson,
  setCheaterData,
  handleShowSupportMe,
  lastSearchIdRef,
}: UseCheaterProbabilityParams) => {
  const { activeRunRef, isCurrentRun } = runGuard;

  // Kept fresh every render, synchronously — see note above. Do not read
  // these during render; only inside getCheaterProbability's callback.
  const isLoadingFriendsCardsRef = useRef(isLoadingFriendsCards);
  isLoadingFriendsCardsRef.current = isLoadingFriendsCards;

  const targetInfoJsonRef = useRef(targetInfoJson);
  targetInfoJsonRef.current = targetInfoJson;

  const closeFriendsJsonRef = useRef(closeFriendsJson);
  closeFriendsJsonRef.current = closeFriendsJson;

  const getCheaterProbability =
    useCallback(async (): Promise<CheaterDataType | null> => {
      if (isLoadingFriendsCardsRef.current) {
        return null;
      }

      const target = targetInfoJsonRef.current?.profileInfo?.steamID;
      const runId = activeRunRef.current;

      try {
        handleShowSupportMe(3);

        setIsLoading((prev) => ({ ...prev, cheaterReport: true }));

        track('cheater_probability_requested', {
          target: target ?? '',
        });

        const response = await axios.post('/api/getCheaterProbability', {
          target,
          closeFriends: closeFriendsJsonRef.current ?? [],
        });

        const cheaterProbability: CheaterDataType = response?.data;

        console.log('--- Cheater Probability Analysis ---');
        console.log('Probability:', cheaterProbability.cheaterProbability);
        console.log('Features:', cheaterProbability.featureObject);

        if (
          cheaterProbability.featureObject.bannedFriendsDetails &&
          cheaterProbability.featureObject.bannedFriendsDetails.length > 0
        ) {
          console.group('🚨 Banned Friends Detected:');

          cheaterProbability.featureObject.bannedFriendsDetails.forEach(
            (friend) => {
              console.log(`${friend.nickname} (${friend.steamID})`);
              console.log(`URL: ${friend.profileUrl}`);
              console.log(`Bans:`, friend.bans);
              console.log('---');
            },
          );

          console.groupEnd();
        } else {
          console.log('✅ No banned friends found in the analyzed circle.');
        }

        if (!isCurrentRun(runId)) {
          // User has already navigated to another profile — do not apply this
          // result to the state, but still return it to the caller.
          return cheaterProbability;
        }

        setCheaterData(cheaterProbability);

        if (target) {
          updateCachedSearchById(target, {
            cheaterData: cheaterProbability,
          });
        }

        if (lastSearchIdRef.current) {
          axios
            .post(
              '/api/recordAnalyticsCheater',
              {
                searchId: lastSearchIdRef.current,
                score: cheaterProbability.cheaterProbability,
                bannedFriendsCount:
                  cheaterProbability.featureObject.bannedFriendsDetails
                    ?.length ?? 0,
              },
              {
                headers: getAnalyticsSkipHeaders(),
              },
            )
            .catch((e) => {
              console.error(
                '[Analytics] Failed to attach cheater probability:',
                e,
              );
            });
        }

        return cheaterProbability;
      } catch (e) {
        if (isCurrentRun(runId)) {
          toast.error('Failed to calculate cheater probability');
        }

        console.error('getCheaterProbability error:', e);

        return null;
      } finally {
        if (isCurrentRun(runId)) {
          setIsLoading((prev) => ({
            ...prev,
            cheaterReport: false,
          }));
        }
      }

      // setIsLoading/setCheaterData are useState setters passed through props.
      // They are referentially stable, so including them here does not change
      // the behavior (they never trigger a recreation). This only avoids
      // needing an eslint-disable for exhaustive-deps.
    }, [
      handleShowSupportMe,
      setIsLoading,
      setCheaterData,
      isCurrentRun,
      activeRunRef,
    ]);

  return { getCheaterProbability };
};

export default useCheaterProbability;
