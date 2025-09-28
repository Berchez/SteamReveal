import { CheaterDataType } from '@/@types/cheaterDataType';
import { isLoadingType } from '@/@types/isLoadingType';
import { createContext } from 'react';

interface HomeContextType {
  handleGetInfoClick: (value: string, key: string) => Promise<void>;
  getCheaterProbability: () => Promise<CheaterDataType | null>;
  isLoading: isLoadingType;
}

const HomeContext = createContext<HomeContextType | null>(null);

export default HomeContext;
