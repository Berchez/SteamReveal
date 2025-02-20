'use client';
import React, { useEffect } from 'react';

function AdSense() {
  useEffect(() => {
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = 'https://faves.grow.me/main.js';
    script.defer = true;
    script.setAttribute(
      'data-grow-faves-site-id',
      'U2l0ZTpjYzRiYmVlOS1jZWU0LTRmOWItODhiNS0yMjE5Y2ZiN2QwYjU=',
    );

    document.body.appendChild(script);

    return () => {
      document.body.removeChild(script);
    };
  }, []);

  return null;
}

export default AdSense;
