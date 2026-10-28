import React from 'react';

type LocationMapProps = {
  query: string;
  isTop?: boolean;
};

export default function LocationMap({ query, isTop }: LocationMapProps) {
  return (
    <div
      className={`my-6 ${isTop ? 'border-b' : 'border-t'} border-gray-100/20 ${
        isTop ? 'pb-6' : 'pt-6'
      } animate-map-fade-zoom`}
    >
      <div className="w-full h-[400px] rounded-lg overflow-hidden border-2 border-purple-500/40 shadow-[0_0_25px_rgba(168,85,247,0.25)] relative group">
        <div className="absolute inset-0 pointer-events-none border border-white/5 rounded-lg z-10" />
        <iframe
          title="Google Maps Location"
          width="100%"
          height="100%"
          style={{
            border: 0,
            filter: 'contrast(1.1) brightness(0.9) saturate(1.2)',
          }}
          loading="lazy"
          allowFullScreen
          referrerPolicy="no-referrer-when-downgrade"
          src={`https://www.google.com/maps?q=${encodeURIComponent(
            query,
          )}&output=embed`}
        />
      </div>
    </div>
  );
}
