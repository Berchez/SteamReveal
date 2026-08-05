'use client';

import React, { useEffect, useState } from 'react';

interface UserQuickLinksProps {
  steamId: string;
}

interface QuickLink {
  title: string;
  icon: string;
  iconUrl?: string;
  url?: string;
  getUrl?: (steamId: string) => string;
  color: string;
  isDynamic?: boolean;
}

const staticQuickLinks: QuickLink[] = [
  {
    title: 'SteamHistory',
    icon: '📜',
    iconUrl:
      'https://storage.ko-fi.com/cdn/useruploads/91a12520-96ba-4a53-839e-8b8ae9898ce2_e66bd745-c7b3-489c-b6e5-decb14527111.png',
    getUrl: (steamId: string) => `https://steamhistory.net/id/${steamId}`,
    color: 'from-purple-700 to-purple-500',
  },
  {
    title: 'SteamID.uk',
    icon: '🔍',
    iconUrl: 'https://i.imgur.com/qKLLYRC.png',
    getUrl: (steamId: string) => `https://steamid.uk/profile/${steamId}`,
    color: 'from-purple-700 to-purple-500',
  },
  {
    title: 'CSStats',
    icon: '📊',
    iconUrl:
      'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSOd6S7y-5ftqzuy8ICDFloDWHRYCGkgeCggiOqaylbmnMGbebOTVMas1u5&s=10',
    getUrl: (steamId: string) => `https://csstats.gg/player/${steamId}`,
    color: 'from-purple-700 to-purple-500',
  },
  {
    title: 'CSRep',
    icon: '📈',
    iconUrl:
      'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRgf7Omi-kFi8i94p4aapJcRMPNld11IEDHMDSdCUcxPw&s=10',
    getUrl: (steamId: string) => `https://csrep.gg/player/${steamId}`,
    color: 'from-purple-700 to-purple-500',
  },
  {
    title: 'Clash Inventory',
    icon: '📦',
    iconUrl:
      'https://play-lh.googleusercontent.com/VP6nRWGNvdq1c1CxPO14pWkqPqe4LMro1Q2jwNoXnps1Wj7Sp6ALKjYz7JuQHyccVkc',
    getUrl: (steamId: string) => `https://inventory.clash.gg/users/${steamId}`,
    color: 'from-purple-700 to-purple-500',
  },
  {
    title: 'GamersClub',
    icon: 'GC',
    iconUrl: 'https://gamersclub.com.br/favicon.ico',
    getUrl: (steamId: string) =>
      `https://gamersclub.com.br/buscar?busca=${encodeURIComponent(
        `https://steamcommunity.com/profiles/${steamId}/`,
      )}`,
    color: 'from-purple-700 to-purple-500',
  },
];

function UserQuickLinks({ steamId }: UserQuickLinksProps) {
  const [faceitUrl, setFaceitUrl] = useState<string>('');
  const [isLoadingFaceit, setIsLoadingFaceit] = useState(true);

  useEffect(() => {
    const fetchFaceitLink = async () => {
      try {
        const response = await fetch(`/api/getFaceitLink?steamID=${steamId}`);
        if (response.ok) {
          const data = await response.json();
          setFaceitUrl(data.faceitLink);
        } else {
          setFaceitUrl(`https://faceitfinder.com/profile/${steamId}`);
        }
      } catch (error) {
        console.error('Error fetching Faceit link:', error);
        setFaceitUrl(`https://faceitfinder.com/profile/${steamId}`);
      } finally {
        setIsLoadingFaceit(false);
      }
    };

    fetchFaceitLink();
  }, [steamId]);

  const faceitLink: QuickLink = {
    title: 'Faceit',
    icon: '🎮',
    iconUrl:
      'https://avatars.akamai.steamstatic.com/e74d4f1f7730b917c5a33c492a1112973862bb47_full.jpg',
    url: faceitUrl,
    color: 'from-purple-700 to-purple-500',
    isDynamic: true,
  };

  // Build list: keep static links and insert faceitLink after the first three items
  const allLinks = [
    ...staticQuickLinks.slice(0, 3),
    faceitLink,
    ...staticQuickLinks.slice(3),
  ];

  const numCols = Math.min(4, allLinks.length);

  return (
    <div className="w-full pt-2">
      <div
        className="grid gap-2 mx-auto"
        style={{
          gridTemplateColumns: `repeat(${numCols}, minmax(30px, 50px))`,
        }}
      >
        {allLinks.map((link) => {
          const linkUrl =
            link.url || (link.getUrl ? link.getUrl(steamId) : '#');
          const isDisabled = link.isDynamic && isLoadingFaceit;

          let linkContent;
          if (isDisabled && link.isDynamic) {
            linkContent = (
              <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
            );
          } else if (link.iconUrl) {
            linkContent = (
              <img
                src={link.iconUrl}
                alt={`${link.title} icon`}
                className="rounded-full w-full h-full object-cover"
              />
            );
          } else {
            linkContent = (
              <span className="rounded-full w-full h-full flex items-center justify-center text-sm bg-transparent">
                {link.icon}
              </span>
            );
          }

          return (
            <a
              key={link.title}
              href={linkUrl}
              target="_blank"
              rel="noreferrer"
              title={link.title}
              onClick={(e) => {
                if (isDisabled) {
                  e.preventDefault();
                }
              }}
              className={`relative flex items-center justify-center ${isDisabled ? 'opacity-50 pointer-events-none' : ''}`}
            >
              {linkContent}

              <div className="absolute -top-10 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity duration-200 text-xs text-white bg-gray-900 px-2 py-1 rounded whitespace-nowrap pointer-events-none">
                {link.title}
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

export default UserQuickLinks;
