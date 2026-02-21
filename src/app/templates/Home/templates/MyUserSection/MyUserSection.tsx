import React, { useContext } from 'react';
import { useTranslations } from 'next-intl';
import targetInfoJsonType from '@/@types/targetInfoJsonType';
import dynamic from 'next/dynamic';
import SearchInput from '../SearchInput';
import HomeContext from '../../context';
import { fetchSteamId } from '../../useHome';

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

  const context = useContext(HomeContext);

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
          fetchSteamId(targetValue.current ?? '').then((steamId) =>
            context?.updateQueryParam('player', steamId),
          );
        }}
        onSearch={() =>
          fetchSteamId(targetValue.current ?? '').then((steamId) =>
            context?.updateQueryParam('player', steamId),
          )
        }
      />
      {targetInfoJson ? (
        <UserCard friend={targetInfoJson.profileInfo} itsTargetUser />
      ) : (
        isLoading && <UserCardSkeleton itsTargetUser />
      )}
    </div>
  );
}

export default MyUserSection;
