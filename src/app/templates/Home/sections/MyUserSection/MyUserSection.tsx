import React, { useContext } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'react-toastify';
import targetInfoJsonType from '@/@types/targetInfoJsonType';
import dynamic from 'next/dynamic';
import SearchInput from '../SearchInput';
import { HomeDataContext, HomeActionsContext } from '../../context';
import { fetchSteamId } from '../../hooks/useHome';

const UserCard = dynamic(() => import('@/app/components/UserCard'));
const UserCardSkeleton = dynamic(
  () => import('@/app/components/UserCard/UserCardSkeleton'),
);

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

  const handleSearch = () => {
    const value = (targetValue.current ?? '').trim();

    if (!value) {
      toast.error(serverMessagesTranslator('invalidPlayer'));
      return;
    }

    fetchSteamId(value)
      .then(handleResolvedSearch)
      .catch(() => {
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
            // Always mounted now — swaps its inner content instead of
            // unmounting the whole wrapper. `friendsCards` toggles
            // true/false multiple times per search (start loading → done),
            // and unmounting this block each time was shifting everything
            // above/below it in the flex column on every toggle.
            <div className="relative rounded-xl p-[1px] w-fit inline-flex items-center justify-center group">
              {data?.isLoading.friendsCards ? (
                <div
                  className="px-4 py-2 text-sm font-medium rounded-xl border border-transparent invisible"
                  aria-hidden="true"
                >
                  {translator('csAnticheatReview')}
                </div>
              ) : (
                <>
                  <div
                    className="absolute inset-0 rounded-xl bg-[length:200%_200%] animate-gradient-spin"
                    style={{
                      backgroundImage:
                        'linear-gradient(90deg, #ff8ae2, #ff1bce, #ea00ff, #9a64ff, #3d5afe, #ae00ff, #ff8ae2, #ff1bce, #ea00ff)',
                    }}
                  />
                  <button
                    onClick={() => actions?.getCheaterProbability()}
                    className="relative z-10 px-4 py-2 text-sm font-medium text-white rounded-xl bg-[#1c0029d7] backdrop-blur-md border border-transparent group-hover:shadow-[0_0_20px_rgba(255,100,249,0.5)] transition duration-200"
                    type="button"
                  >
                    {translator('csAnticheatReview')}
                  </button>
                </>
              )}
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
