'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Portal from '../Portal';
import axios from 'axios';
import { useTranslations } from 'next-intl';

function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [type, setType] = useState<'bug' | 'suggestion' | 'other'>(
    'suggestion',
  );
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitFeedback() {
    if (!message.trim()) return;

    setLoading(true);
    setError(null);

    try {
      await axios.post('/api/feedback', {
        message,
        type,
        page: window.location.pathname,
        language: navigator.language,
        userAgent: navigator.userAgent,
      });

      setError(null);
      setSuccess(true);
      setMessage('');

      setTimeout(() => {
        setOpen(false);
        setSuccess(false);
      }, 1600);
    } catch (err: unknown) {
      let status: number | undefined;

      if (axios.isAxiosError(err)) {
        status = err.response?.status;
      }

      switch (status) {
        case 429:
          setError(translator('errors.rateLimit'));
          break;
        case 502:
          setError(translator('errors.generic')); // provider down
          break;
        default:
          setError(translator('errors.generic'));
      }
    } finally {
      setLoading(false);
    }
  }

  const translator = useTranslations('feedback');

  return (
    <>
      {/* Open button */}
      <button
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        type="button"
        className="
          px-6 py-3 rounded-full text-base font-medium
          text-purple-100
          bg-purple-700
          hover:bg-purple-600
          transition
        "
      >
        {translator('openButton')}
      </button>

      <Portal>
        <AnimatePresence>
          {open && (
            <motion.div
              className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <motion.div
                className="
                  relative w-full max-w-lg
                  bg-[#1f1f2e]
                  rounded-2xl
                  px-10 py-9
                  shadow-2xl
                  border border-purple-500/30
                "
                initial={{ scale: 0.97, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.97, opacity: 0 }}
              >
                {/* Close */}
                <button
                  onClick={() => setOpen(false)}
                  type="button"
                  className="
                    absolute right-5 top-5
                    text-purple-300 hover:text-purple-400
                    text-2xl
                  "
                  aria-label={translator('close')}
                >
                  &times;
                </button>

                {/* Title */}
                <h3 className="text-2xl font-semibold text-purple-300 mb-2">
                  {translator('title')}
                </h3>

                <p className="text-base text-gray-300 mb-6">
                  {translator('description')}
                </p>

                {/* Textarea */}
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={translator('placeholder')}
                  disabled={loading}
                  maxLength={1800}
                  className="
                    w-full h-32 resize-none rounded-xl p-4 text-base
                    bg-[#161622]
                    text-gray-100
                    border border-purple-500/30
                    placeholder:text-gray-400
                    focus:outline-none
                    focus:ring-2 focus:ring-purple-500/40
                    transition
                  "
                />

                {/* Type selector */}
                <div className="flex gap-3 mt-2">
                  {(['suggestion', 'bug', 'other'] as const).map((tType) => (
                    <button
                      key={tType}
                      onClick={() => setType(tType)}
                      type="button"
                      className={`
                        px-5 py-2 rounded-full text-sm font-medium transition
                        ${
                          type === tType
                            ? 'bg-purple-600/30 text-purple-200 border border-purple-500/50'
                            : 'bg-transparent text-gray-400 border border-gray-600 hover:text-gray-200'
                        }
                      `}
                    >
                      {translator(`types.${tType}`)}
                    </button>
                  ))}
                </div>

                {/* Actions */}
                <div className="flex justify-end gap-4 mt-12">
                  <button
                    onClick={() => setOpen(false)}
                    disabled={loading}
                    type="button"
                    className="text-gray-400 hover:text-gray-300 text-base"
                  >
                    {translator('cancel')}
                  </button>

                  <button
                    onClick={submitFeedback}
                    disabled={loading}
                    type="button"
                    className="
                      px-6 py-2 rounded-xl text-base font-semibold
                      text-white
                      bg-purple-600 hover:bg-purple-700
                      transition
                    "
                  >
                    {loading ? translator('sending') : translator('send')}
                  </button>
                </div>

                {error && <p className="text-sm text-red-400 mt-4">{error}</p>}

                {/* Success */}
                {success && (
                  <p className="text-sm text-green-400 mt-4">
                    {translator('success')}
                  </p>
                )}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </Portal>
    </>
  );
}

export default FeedbackButton;
