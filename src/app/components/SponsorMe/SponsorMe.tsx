import { useTranslations } from 'next-intl';
import React from 'react';

interface SponsorMeProps {
  onClose: () => void;
  dontAskAgain: () => void;
}

function SponsorMe({ onClose, dontAskAgain }: SponsorMeProps) {
  const translator = useTranslations('SponsorMe');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-70">
      <div className="flex flex-col relative w-full max-w-md px-8 pt-8 pb-3 bg-[#1c1c28] border border-purple-500 shadow-lg rounded-lg">
        <h2 className="text-2xl text-purple-300 font-bold text-center mb-4">
          {translator('enjoying')}
        </h2>
        <p className="text-purple-100 text-center mb-6">
          {translator('ifYouLikeIt')}
        </p>
        <div className="flex justify-center">
          <a
            href="https://github.com/Berchez/SteamReveal"
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 text-white bg-purple-600 hover:bg-purple-700 rounded-lg"
          >
            {translator('giveStar')}
          </a>
        </div>
        <button
          type="button"
          className="self-center mt-6 text-gray-500 underline pointer hover:text-gray-400 bg-transparent border-none"
          onClick={dontAskAgain}
        >
          {translator('dontAskAgain')}
        </button>
        <button
          onClick={onClose}
          type="button"
          className="absolute top-0 right-2 text-purple-300 hover:text-purple-500 md:text-4xl text-3xl"
        >
          &times;
        </button>
      </div>
    </div>
  );
}

export default SponsorMe;
