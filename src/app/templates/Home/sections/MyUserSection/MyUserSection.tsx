import React, { useContext, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'react-toastify';

import targetInfoJsonType from '@/@types/targetInfoJsonType';
import UserCard from '@/app/components/UserCard';
import UserCardSkeleton from '@/app/components/UserCard/UserCardSkeleton';

import SearchInput from '../SearchInput';
import { HomeDataContext, HomeActionsContext } from '../../context';
import { fetchSteamId } from '../../hooks/useHome';

type MyUserSectionProps = {
  targetInfoJson: targetInfoJsonType;
  isLoading: boolean;
  onChangeTarget: (value: string) => void;
  targetValue: React.MutableRefObject<string | null | undefined>;
  className?: string;
};

function MyUserSection({
  targetInfoJson,
  isLoading,
  onChangeTarget,
  targetValue,
  className,
}: MyUserSectionProps) {
  const translator = useTranslations('Index');
  const serverMessagesTranslator = useTranslations('ServerMessages');

  const data = useContext(HomeDataContext);
  const actions = useContext(HomeActionsContext);

  const handleResolvedSearch = (steamId: string) => {
    if (!steamId) {
      toast.error(serverMessagesTranslator('invalidPlayer'));
      return;
    }
    actions?.navigateToPlayer(steamId);
  };

  const searchSeqRef = useRef(0);

  const handleSearch = () => {
    const value = (targetValue.current ?? '').trim();

    if (!value) {
      toast.error(serverMessagesTranslator('invalidPlayer'));
      return;
    }

    searchSeqRef.current += 1;
    const seq = searchSeqRef.current;

    fetchSteamId(value)
      .then((steamId) => {
        if (searchSeqRef.current !== seq) {
          return;
        }

        handleResolvedSearch(steamId);
      })
      .catch(() => {
        if (searchSeqRef.current !== seq) {
          return;
        }

        toast.error(serverMessagesTranslator('invalidPlayer'));
      });
  };

  return (
    <div className={`flex flex-col w-full mx-auto gap-y-8 ${className}`}>
      <h1 className="text-3xl font-bold text-center">
        {translator('searchTitle')}
      </h1>
      <SearchInput
        onChange={({ target }) => onChangeTarget(target.value)}
        placeholder={translator('inputSearchPlaceholder')}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') {
            return;
          }
          handleSearch();
        }}
        onSearch={handleSearch}
      />
      {targetInfoJson ? (
        <UserCard
          friend={targetInfoJson.profileInfo}
          itsTargetUser
          preloadedLocationInfo={targetInfoJson.targetLocationInfo}
          bottomChildren={
            // Same-sized button in both states (no layout shift on toggle).
            // While close-friends are loading the button is disabled and shows
            // a spinner — we must not run the cheater-probability fetch until
            // the friends list has settled, because the endpoint produces a
            // far less reliable score when it runs without close friends.
            // Once the close-friends load finishes it is ENABLED regardless of
            // the result (0 friends = private profile / private friends list /
            // genuinely friendless — still a valid click target).
            <div className="relative rounded-xl p-[1px] w-fit inline-flex items-center justify-center group">
              <div
                className="absolute inset-0 rounded-xl bg-[length:200%_200%] animate-gradient-spin"
                style={{
                  backgroundImage:
                    'linear-gradient(90deg, #ff8ae2, #ff1bce, #ea00ff, #9a64ff, #3d5afe, #ae00ff, #ff8ae2, #ff1bce, #ea00ff)',
                }}
              />
              <button
                onClick={() => actions?.openCheaterReport()}
                disabled={data?.isLoading.friendsCards}
                className="relative z-10 px-4 py-2 text-sm font-medium text-white rounded-xl bg-[#1c0029d7] backdrop-blur-md border border-transparent group-hover:shadow-[0_0_20px_rgba(255,100,249,0.5)] transition duration-200 disabled:cursor-not-allowed disabled:opacity-60 disabled:group-hover:shadow-none"
                type="button"
              >
                <span className="inline-flex items-center gap-2">
                  {translator('csAnticheatReview')}
                  {data?.isLoading.friendsCards && (
                    <span
                      className="w-3 h-3 border-2 border-gray-200 border-t-transparent rounded-full animate-spin"
                      aria-hidden="true"
                    />
                  )}
                </span>
              </button>
            </div>
          }
        />
      ) : (
        isLoading && <UserCardSkeleton itsTargetUser />
      )}
    </div>
  );
}

export default MyUserSection;
