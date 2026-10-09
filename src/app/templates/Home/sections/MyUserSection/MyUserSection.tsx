import React, { useContext, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'react-toastify';

import targetInfoJsonType from '@/@types/targetInfoJsonType';
import UserCard from '@/app/components/UserCard';
import UserCardSkeleton from '@/app/components/UserCard/UserCardSkeleton';
import GradientButton from '@/app/components/GradientButton';
import ShareBar from '@/app/components/ShareBar';

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
    <div data-testid="my-user-section" className={`flex flex-col w-full mx-auto gap-y-8 ${className}`}>
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
          topRightChildren={
            targetInfoJson.profileInfo.steamID ? (
              <ShareBar
                steamId={targetInfoJson.profileInfo.steamID}
                nickname={targetInfoJson.profileInfo.nickname}
              />
            ) : undefined
          }
          bottomChildren={
            // While close-friends are loading the button is disabled and shows
            // a spinner — we must not run the
            // cheater-probability fetch until the friends list has settled,
            // because the endpoint produces a far less reliable score when
            // it runs without close friends. Once the close-friends load
            // finishes it is ENABLED regardless of the result (0 friends =
            // private profile / private friends list / genuinely friendless
            // — still a valid click target).
            <GradientButton
              onClick={() => actions?.openCheaterReport()}
              disabled={data?.isLoading.friendsCards}
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
            </GradientButton>
          }
        />
      ) : (
        isLoading && <UserCardSkeleton itsTargetUser />
      )}
    </div>
  );
}

export default MyUserSection;
