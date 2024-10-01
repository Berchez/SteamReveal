import Image from 'next/image';
import React from 'react';

const VideoBackground = () => {
  const env = process.env.NODE_ENV;
  if (env === 'development') {
    return (
      <Image
        src={'/images/background.png'}
        alt="image for the background"
        fill
      />
    );
  }

  return (
    <video
      loop
      autoPlay
      muted
      className="object-cover w-screen h-screen fixed top-0 left-0 z-0 brightness-90"
      poster="/images/background.png"
    >
      <source
        src="https://enuzgyrzryukbbsgtibn.supabase.co/storage/v1/object/public/video/background.mp4?t=2024-09-27T21%3A13%3A31.593Z"
        type="video/mp4"
      />
    </video>
  );
};
export default VideoBackground;
