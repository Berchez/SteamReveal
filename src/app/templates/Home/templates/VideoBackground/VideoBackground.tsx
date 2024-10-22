import Image from 'next/image';
import React from 'react';

function VideoBackground() {
  const env = process.env.NODE_ENV;
  if (env === 'development') {
    return <Image src="/images/background.webp" alt="background" fill />;
  }

  return (
    <video
      loop
      autoPlay
      muted
      className="object-cover w-screen h-screen fixed top-0 left-0 z-0 brightness-90"
      poster="/images/background.webp"
    >
      <source src="/videos/short-bg.mp4" type="video/mp4" />
    </video>
  );
}
export default VideoBackground;
