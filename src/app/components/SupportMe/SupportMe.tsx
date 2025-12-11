import { useLocale, useTranslations } from 'next-intl';
import React, { useState } from 'react';
import Image from 'next/image';

interface SupportMeProps {
  onClose: () => void;
  dontAskAgain: () => void;
}

const PIX_KEY = 'walterfelipeberchez@outlook.com';
const PIX_QR = '/images/qrcode-pix.png';

const STRIPE = {
  brl: 'https://buy.stripe.com/test_4gMfZjduP63gcqm0BI4ko00',
  usd: 'https://buy.stripe.com/test_3cIbJ3duPbnA61Y4RY4ko01',
  qrBrl: '/images/stripeBR.png',
  qrUsd: '/images/stripeUSD.png',
};

const STEAM_TRADE_URL =
  'https://steamcommunity.com/tradeoffer/new/?partner=186067647&token=YbRxxqXH';

export default function SupportMe({ onClose, dontAskAgain }: SupportMeProps) {
  const translator = useTranslations('SupportMe');
  const locale = useLocale();
  const isPT = locale?.toLowerCase().startsWith('pt');

  const [tab, setTab] = useState<'pix' | 'stripe' | 'steam'>(
    isPT ? 'pix' : 'stripe',
  );
  const [copied, setCopied] = useState(false);

  const stripeLink = isPT ? STRIPE.brl : STRIPE.usd;
  const stripeQR = isPT ? STRIPE.qrBrl : STRIPE.qrUsd;

  const qrSource: Record<'pix' | 'stripe', string> = {
    pix: PIX_QR,
    stripe: stripeQR,
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Clipboard error', err);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="relative max-w-md w-full bg-[#1c1c28] rounded-xl border border-purple-500/40 px-8 py-8 text-center shadow-xl">
        {/* Close */}
        <button
          onClick={onClose}
          className="absolute right-4 top-2 text-3xl text-purple-300 hover:text-purple-400"
          type="button"
        >
          &times;
        </button>

        {/* Title + Text */}
        <h2 className="text-2xl text-purple-300 font-bold mb-2">
          {translator('supportTitle')}
        </h2>

        <p className="text-purple-100 mb-6 opacity-90 text-sm">
          {translator('supportText')}
        </p>

        {/* Tabs */}
        <div className="flex border-b border-purple-700/30 mb-6 text-sm">
          {isPT && (
            <button
              onClick={() => setTab('pix')}
              className={`flex-1 py-2 ${
                tab === 'pix'
                  ? 'text-purple-300 border-b-2 border-purple-500 font-semibold'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
              type="button"
            >
              PIX
            </button>
          )}

          <button
            onClick={() => setTab('stripe')}
            className={`flex-1 py-2 ${
              tab === 'stripe'
                ? 'text-purple-300 border-b-2 border-purple-500 font-semibold'
                : 'text-gray-400 hover:text-gray-200'
            }`}
            type="button"
          >
            STRIPE
          </button>

          <button
            onClick={() => setTab('steam')}
            className={`flex-1 py-2 ${
              tab === 'steam'
                ? 'text-purple-300 border-b-2 border-purple-500 font-semibold'
                : 'text-gray-400 hover:text-gray-200'
            }`}
            type="button"
          >
            STEAM
          </button>
        </div>

        {/* QR (only PIX and Stripe) */}
        {(tab === 'pix' || tab === 'stripe') && qrSource[tab] && (
          <Image
            src={qrSource[tab]}
            alt="QR Code"
            width={220}
            height={220}
            className="mx-auto bg-white p-2 rounded-lg shadow-md"
          />
        )}

        {/* PIX COPY */}
        {tab === 'pix' && isPT && (
          <div className="bg-[#262637] border border-purple-500/20 rounded-lg p-3 mt-4">
            <p className="text-purple-300 text-sm font-medium mb-1">
              {translator('myPixKey')}:
            </p>

            <div className="flex items-center justify-between bg-[#1f1f2d] border border-purple-500/20 rounded-md px-3 py-2 gap-x-1">
              <span className="text-gray-200 text-sm select-all break-all ">
                {PIX_KEY}
              </span>

              <button
                onClick={() => copyToClipboard(PIX_KEY)}
                className="text-purple-300 hover:text-purple-400 text-sm"
                type="button"
              >
                {copied ? translator('copied') : translator('copy')}
              </button>
            </div>
          </div>
        )}

        {/* Stripe Button */}
        {tab === 'stripe' && (
          <a
            href={stripeLink}
            target="_blank"
            rel="noreferrer"
            className="mt-6 block text-center bg-purple-700/50 text-white py-2 rounded-lg border border-purple-400/60 shadow-[0_0_4px_rgba(168,85,247,0.8)] hover:shadow-[0_0_14px_rgba(168,85,247,1)] hover:-translate-y-[2px] transition"
          >
            {translator('openStripe')}
          </a>
        )}

        {/* Steam Donate */}
        {tab === 'steam' && (
          <div className="bg-[#262637] border border-purple-500/20 rounded-lg p-3 mt-4 text-left">
            <p className="text-purple-300 text-sm font-medium mb-1">
              {translator('tradeLink')}
            </p>

            <div className="flex items-center justify-between bg-[#1f1f2d] border border-purple-500/20 rounded-md px-3 py-2 gap-x-1">
              <span className="text-gray-200 text-sm select-all break-all">
                {STEAM_TRADE_URL}
              </span>

              <button
                onClick={() => copyToClipboard(STEAM_TRADE_URL)}
                className="text-purple-300 hover:text-purple-400 text-sm"
                type="button"
              >
                {copied ? translator('copied') : translator('copy')}
              </button>
            </div>

            <a
              href={STEAM_TRADE_URL}
              target="_blank"
              className="mt-4 block text-center bg-purple-700/50 text-white py-2 rounded-lg border border-purple-400/60 shadow-[0_0_4px_rgba(168,85,247,0.8)] hover:shadow-[0_0_14px_rgba(168,85,247,1)] hover:-translate-y-[2px] transition"
              rel="noreferrer"
            >
              {translator('sendSkin')}
            </a>
          </div>
        )}

        {/* Don't ask again */}
        <button
          onClick={dontAskAgain}
          className="mt-6 text-gray-500 hover:text-gray-400 underline text-sm"
          type="button"
        >
          {translator('dontAskAgain')}
        </button>
      </div>
    </div>
  );
}
