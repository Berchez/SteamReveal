import Image from 'next/image';
import React from 'react';

function VideoBackground() {
  const env = process.env.NODE_ENV;
  if (env === 'development') {
    return (
      <div className="fixed inset-0 z-0">
        <Image src="/images/background.webp" alt="background" fill priority />
      </div>
    );
  }

  return (
    <video
      loop
      preload="metadata"
      autoPlay
      muted
      playsInline
      className="object-cover w-screen h-screen fixed top-0 left-0 z-0 brightness-90"
      poster="/images/background.webp"
    >
      <source src="/videos/short-bg.webm" type="video/webm" />
      <source src="/videos/short-bg.mp4" type="video/mp4" />
    </video>
  );
}
export default VideoBackground;
