import Script from 'next/script';
import React from 'react';

function AdSense() {
  return (
    <Script
      id="grow-me-script"
      strategy="afterInteractive"
      dangerouslySetInnerHTML={{
        __html: `!(function(){window.growMe||((window.growMe=function(e){window.growMe._.push(e);}),(window.growMe._=[]));var e=document.createElement("script");(e.type="text/javascript"),(e.src="https://faves.grow.me/main.js"),(e.defer=!0),e.setAttribute("data-grow-faves-site-id","U2l0ZTpjYzRiYmVlOS1jZWU0LTRmOWItODhiNS0yMjE5Y2ZiN2QwYjU=");var t=document.getElementsByTagName("script")[0];t.parentNode.insertBefore(e,t);})();`,
      }}
    />
  );
}

export default AdSense;
