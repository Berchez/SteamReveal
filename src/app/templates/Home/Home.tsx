'use client';

import React, { useMemo } from 'react';
import dynamic from 'next/dynamic';
import SponsorMe from '@/app/components/SponsorMe';
import SupportMe from '@/app/components/SupportMe';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import useHome from './useHome';
import VideoBackground from './templates/VideoBackground';
import MyUserSection from './templates/MyUserSection';
import WelcomeText from './WelcomeText/WelcomeText';
import HomeContext from './context';
import CheaterReport from './templates/CheaterReport';
import SupportedFormatsSection from './templates/SupportedFormatsSection';

const LocationSection = dynamic(() => import('./templates/LocationSection'));
const FriendsSection = dynamic(() => import('./templates/FriendsSection'));

export default function Home() {
  const {
    onChangeTarget,
    closeFriendsJson,
    targetValue,
    possibleLocationJson,
    targetInfoJson,
    isLoading,
    hasNoDataYet,
    showSponsorMe,
    onCloseSponsorMe,
    cheaterData,
    getCheaterProbability,
    updateQueryParam,
    showSupportMe,
    onCloseSupportMe,
  } = useHome();

  const contextValue = useMemo(
    () => ({
      updateQueryParam,
      getCheaterProbability,
      isLoading,
    }),
    [updateQueryParam, getCheaterProbability, isLoading],
  );

  const translator = useTranslations('Index');

  return (
    <HomeContext.Provider value={contextValue}>
      <div className="max-h-dvh">
        <VideoBackground />
        {showSponsorMe && (
          <SponsorMe
            onClose={() => onCloseSponsorMe(0)}
            dontAskAgain={() => onCloseSponsorMe(-20)}
          />
        )}

        {showSupportMe && (
          <SupportMe
            onClose={() => onCloseSupportMe(0)}
            dontAskAgain={() => onCloseSupportMe(-25)}
          />
        )}

        {hasNoDataYet && <WelcomeText />}

        <div
          className={`flow-root h-full w-full min-h-screen bg-no-repeat bg-cover py-8 px-4 md:p-12 text-white z-20 ${
            hasNoDataYet
              ? 'absolute top-1/2 transform -translate-y-1/2'
              : 'relative'
          }`}
        >
          <div className="min-h-[70dvh]">
            <MyUserSection
              targetInfoJson={targetInfoJson}
              isLoading={isLoading.myCard}
              onChangeTarget={onChangeTarget}
              targetValue={targetValue}
              className={hasNoDataYet ? 'mt-[25vh]' : ''}
            />
            {hasNoDataYet && <SupportedFormatsSection />}
          </div>

          {hasNoDataYet && (
            <>
              <section className="text-white text-center px-6">
                <motion.h2
                  className="text-2xl font-bold mb-6"
                  initial={{ opacity: 0 }}
                  whileInView={{ opacity: 1 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5 }}
                >
                  {translator('whyUse.title')}
                </motion.h2>

                <div className="grid md:grid-cols-3 gap-6">
                  <motion.div
                    className="bg-slate-900/40 p-6 rounded-xl border border-purple-900 hover:border-purple-600/70 transition"
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, amount: 0.5 }}
                    transition={{ duration: 0.5 }}
                  >
                    <h3 className="font-semibold text-purple-300 mb-2">
                      {translator('whyUse.cards.investigate.title')}
                    </h3>
                    <p className="text-sm text-gray-300">
                      {translator('whyUse.cards.investigate.text')}
                    </p>
                  </motion.div>

                  <motion.div
                    className="bg-slate-900/40 p-6 rounded-xl border border-purple-900 hover:border-purple-600/70 transition"
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, amount: 0.5 }}
                    transition={{ duration: 0.5, delay: 0.1 }}
                  >
                    <h3 className="font-semibold text-purple-300 mb-2">
                      {translator('whyUse.cards.suspicious.title')}
                    </h3>
                    <p className="text-sm text-gray-300">
                      {translator('whyUse.cards.suspicious.text')}
                    </p>
                  </motion.div>

                  <motion.div
                    className="bg-slate-900/40 p-6 rounded-xl border border-purple-900 hover:border-purple-600/70 transition"
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, amount: 0.5 }}
                    transition={{ duration: 0.5, delay: 0.2 }}
                  >
                    <h3 className="font-semibold text-purple-300 mb-2">
                      {translator('whyUse.cards.intelligence.title')}
                    </h3>
                    <p className="text-sm text-gray-300">
                      {translator('whyUse.cards.intelligence.text')}
                    </p>
                  </motion.div>
                </div>
              </section>

              <section className="mt-20 text-center text-white px-6">
                <motion.h2
                  className="text-2xl font-bold mb-4"
                  initial={{ opacity: 0 }}
                  whileInView={{ opacity: 1 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5 }}
                >
                  {translator('numbers.title')}
                </motion.h2>

                <div className="flex flex-wrap justify-center gap-8">
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5, delay: 0.2 }}
                  >
                    <p className="text-4xl font-bold text-purple-400">+12K</p>
                    <p className="text-gray-400">
                      {translator('numbers.visitors')}
                    </p>
                  </motion.div>

                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5, delay: 0.4 }}
                  >
                    <p className="text-4xl font-bold text-purple-400">+17.5K</p>
                    <p className="text-gray-400">
                      {translator('numbers.views')}
                    </p>
                  </motion.div>

                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5, delay: 0.6 }}
                  >
                    <p className="text-4xl font-bold text-purple-400">+18K</p>
                    <p className="text-gray-400">
                      {translator('numbers.playersSearched')}
                    </p>
                  </motion.div>
                </div>
              </section>

              <section className="mt-24 text-center text-white px-6">
                <motion.h2
                  className="text-2xl font-bold mb-4"
                  initial={{ opacity: 0 }}
                  whileInView={{ opacity: 1 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5 }}
                >
                  {translator('feedback.title')}
                </motion.h2>

                <p className="text-gray-300 mb-4">
                  {translator('feedback.description')}
                </p>

                <motion.button
                  type="button"
                  className="bg-purple-600 hover:bg-purple-700 px-6 py-2 rounded-full text-white"
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 17 }}
                  onClick={() => {
                    window.location.href = `mailto:walterfelipeberchez@outlook.com?subject=SteamReveal%20Feedback&body=Hello%20Berchez,%0D%0A%0D%0AI'd%20like%20to%20leave%20some%20feedback:%0D%0A`;
                  }}
                >
                  {translator('feedback.button')}
                </motion.button>
              </section>

              <footer className="mt-24 py-6 text-center text-gray-400 text-sm border-t border-gray-700">
                <p>© 2025 SteamReveal. {translator('footer.rights')}</p>
                <p>
                  {translator('footer.madeWith')}{' '}
                  <a
                    href="https://github.com/Berchez/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-purple-400 hover:underline"
                  >
                    Berchez
                  </a>
                </p>
              </footer>
            </>
          )}

          <CheaterReport
            cheaterData={cheaterData}
            isLoading={isLoading.cheaterReport}
            nickname={targetInfoJson?.profileInfo?.nickname ?? ''}
          />

          <div className="flex flex-col gap-16 my-8">
            <LocationSection
              possibleLocationJson={possibleLocationJson}
              targetInfoJson={targetInfoJson}
              isLoading={isLoading.friendsCards}
            />
            <FriendsSection
              closeFriendsJson={closeFriendsJson}
              isLoading={isLoading.friendsCards}
            />
          </div>
        </div>
      </div>
    </HomeContext.Provider>
  );
}
