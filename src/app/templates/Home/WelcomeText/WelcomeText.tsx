import { useTranslations } from 'next-intl';
import React from 'react';

const WelcomeText = () => {
  const translator = useTranslations('WelcomeText');
  return (
    <div className="flex flex-col justify-center items-center text-center mt-8 p-0 relative z-20 stroke-black">
      <div className="flex items-baseline space-x-4">
        <div className="border-t-2 border-white w-24"></div>
        <h2 className="text-lg ml-0 font-sans">{translator('welcomeTo')}</h2>
        <div className="border-t-2 border-white w-24" />
      </div>
      <h1 className="font-inkut text-4xl mt-2">SteamReveal</h1>
      <div className="border-t-2 border-white w-[320px] mt-4" />
    </div>
  );
};

export default WelcomeText;
