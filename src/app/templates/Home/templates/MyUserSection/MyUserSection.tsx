import React from 'react';
import UserCard from '@/app/components/UserCard';
import UserCardSkeleton from '@/app/components/UserCard/UserCardSkeleton';
import { useTranslations } from 'next-intl';
import targetInfoJsonType from '@/@types/targetInfoJsonType';
import SearchInput from '../SearchInput';

type MyUserSectionProps = {
  targetInfoJson: targetInfoJsonType;
  isLoading: boolean;
  onChangeTarget: (value: string) => void;
  handleGetInfoClick: (value: string, key: string) => Promise<void>;
  targetValue: React.MutableRefObject<string | null | undefined>;
};

function MyUserSection({
  targetInfoJson,
  isLoading,
  onChangeTarget,
  handleGetInfoClick,
  targetValue,
}: MyUserSectionProps) {
  const translator = useTranslations('Index');

  return (
    <div className="flex flex-col h-full w-full items-center justify-center gap-y-8">
      <h1 className="text-3xl font-bold text-center">
        {translator('searchTitle')}
      </h1>
      <SearchInput
        onChange={({ target }) => onChangeTarget(target.value)}
        placeholder={translator('inputSearchPlaceholder')}
        onKeyDown={(e) => handleGetInfoClick(targetValue.current ?? '', e.key)}
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
