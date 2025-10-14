import { useTranslations } from 'next-intl';
import React, { useState } from 'react';

function SupportedFormatsSection() {
  const translator = useTranslations('SupportedFormatsSection');
  const [copied, setCopied] = useState<string | null>(null);

  const supportedOptions = [
    {
      icon: '🔢',
      label: 'SteamID64',
      value: '76561198146333375',
      desc: translator('steamID64Desc'),
    },
    {
      icon: '🔗',
      label: translator('customLabel'),
      value: 'steamcommunity.com/id/officials1mple',
      desc: translator('customDesc'),
    },
    {
      icon: '🧩',
      label: translator('steamID64UrlLabel'),
      value: 'steamcommunity.com/profiles/76561198146333375',
      desc: translator('steamID64UrlDesc'),
    },
  ];

  const handleCopy = (value: string, label: string) => {
    navigator.clipboard.writeText(value);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="w-full flex flex-col items-center gap-4 text-center mt-32 mb-4">
      <h4 className="text-base text-gray-200 tracking-wide">
        {translator('supportedFormats')}
      </h4>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 items-center justify-center gap-3 w-full max-w-xl lg:max-w-3xl mb-10">
        {supportedOptions.map((item) => (
          <button
            key={item.label}
            onClick={() => handleCopy(item.value, item.label)}
            className="relative h-full cursor-pointer group bg-slate-900/40 border-2 border-purple-950 rounded-xl p-3 flex flex-col items-center gap-2 hover:border-purple-600/60 hover:scale-105 hover:rotate-1 transform transition-all duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-purple-600/60"
            type="button"
          >
            <div className="text-purple-400 text-xl">{item.icon}</div>
            <span className="font-medium text-purple-100 text-sm">
              {item.label}
            </span>
            <code className="bg-slate-800/70 rounded-full px-2 py-0.5 text-xs text-purple-200 tracking-tight select-text break-all">
              {item.value}
            </code>
            <p className="text-xs text-purple-300 opacity-0 group-hover:opacity-100 transition leading-tight">
              {item.desc}
            </p>

            {copied === item.label && (
              <div className="absolute top-2 right-2 bg-purple-700 text-white text-xs px-2 py-0.5 rounded-full animate-fade-in-out font-normal">
                {translator('copied')}
              </div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

export default SupportedFormatsSection;
