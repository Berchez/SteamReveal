import React from 'react';

const VideoBackground = () => (
  <video
    src="/videos/background.mp4"
    loop
    autoPlay
    muted
    className="object-cover w-screen h-screen fixed top-0 left-0 z-0 brightness-90"
  />
);

export default VideoBackground;
