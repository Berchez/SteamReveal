import React, { useContext } from 'react';
import { useTranslations } from 'next-intl';
import targetInfoJsonType from '@/@types/targetInfoJsonType';
import dynamic from 'next/dynamic';
import SearchInput from '../SearchInput';
import HomeContext from '../../context';

const UserCard = dynamic(() => import('@/app/components/UserCard'));
const UserCardSkeleton = dynamic(
  () => import('@/app/components/UserCard/UserCardSkeleton'),
);

type MyUserSectionProps = {
  targetInfoJson: targetInfoJsonType;
  isLoading: boolean;
  onChangeTarget: (value: string) => void;
  targetValue: React.MutableRefObject<string | null | undefined>;
};

function MyUserSection({
  targetInfoJson,
  isLoading,
  onChangeTarget,
  targetValue,
}: MyUserSectionProps) {
  const translator = useTranslations('Index');

  const context = useContext(HomeContext);

  return (
    <div className="flex flex-col h-full w-full items-center justify-center gap-y-8">
      <h1 className="text-3xl font-bold text-center">
        {translator('searchTitle')}
      </h1>
      <SearchInput
        onChange={({ target }) => onChangeTarget(target.value)}
        placeholder={translator('inputSearchPlaceholder')}
        onKeyDown={(e) =>
          context?.handleGetInfoClick(targetValue.current ?? '', e.key)
        }
      />
      {targetInfoJson ? (
        <UserCard
          friend={targetInfoJson.profileInfo}
          itsTargetUser
          bottomChildren={
            !context?.isLoading.friendsCards && (
              <div className="relative rounded-xl p-[1px] w-fit inline-flex items-center justify-center group">
                <div
                  className="absolute inset-0 rounded-xl bg-[length:200%_200%] animate-gradient-spin"
                  style={{
                    backgroundImage:
                      'linear-gradient(90deg, #ff8ae2, #ff1bce, #ea00ff, #9a64ff, #3d5afe, #ae00ff, #ff8ae2, #ff1bce, #ea00ff)',
                  }}
                ></div>
                <button
                  onClick={() => context?.getCheaterProbability()}
                  className="relative z-10 px-4 py-2 text-sm font-medium text-white rounded-xl bg-[#1c0029d7] backdrop-blur-md border border-transparent group-hover:shadow-[0_0_20px_rgba(255,100,249,0.5)] transition duration-200"
                >
                  {translator('csAnticheatReview')}
                </button>
              </div>
            )
          }
        />
      ) : (
        isLoading && <UserCardSkeleton itsTargetUser />
      )}
    </div>
  );
}

export default MyUserSection;
