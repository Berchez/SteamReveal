import React from 'react';
import { motion } from 'framer-motion';
import FeedbackButton from '@/app/components/FeedbackButton';
import { useTranslations } from 'next-intl';

export default function PostHeroSections() {
  const translator = useTranslations('PostHeroSections');
  return (
    <>
      {/* WHY USE */}
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
          {(
            [
              { key: 'investigate', delay: 0 },
              { key: 'suspicious', delay: 0.1 },
              { key: 'intelligence', delay: 0.2 },
            ] as const
          ).map(({ key, delay }) => (
            <motion.div
              key={key}
              className="bg-slate-900/60 p-6 rounded-xl border-2 border-purple-900 hover:border-purple-600/70 transition"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.5 }}
              transition={{ duration: 0.5, delay }}
            >
              <h3 className="font-semibold text-purple-300 mb-2">
                {translator(`whyUse.cards.${key}.title`)}
              </h3>
              <p className="text-sm text-gray-300">
                {translator(`whyUse.cards.${key}.text`)}
              </p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* NUMBERS */}
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
          {(
            [
              { value: '+13K', label: 'numbers.visitors', delay: 0.2 },
              { value: '+18K', label: 'numbers.views', delay: 0.4 },
              { value: '+17K', label: 'numbers.playersSearched', delay: 0.6 },
            ] as const
          ).map((item) => (
            <motion.div
              key={item.label}
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: item.delay }}
            >
              <p className="text-4xl font-bold text-purple-400 drop-shadow-[0_0_16px_rgba(171,147,193)]">
                {item.value}
              </p>
              <p className="text-gray-100">{translator(item.label)}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* FEEDBACK */}
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
        <FeedbackButton />
      </section>
    </>
  );
}
