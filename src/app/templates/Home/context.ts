import { createContext } from 'react';

interface HomeContextType {
  handleGetInfoClick: (value: string, key: string) => Promise<void>;
}

const HomeContext = createContext<HomeContextType | null>(null);

export default HomeContext;
