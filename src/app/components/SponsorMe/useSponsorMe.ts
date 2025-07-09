import { useState } from 'react';

const useSponsorMe = () => {
  const [showSponsorMe, setShowSponsorMe] = useState(false);

  const handleShowSponsorMe = () => {
    const visitCount = localStorage.getItem('visitCount');
    const count = visitCount ? parseInt(visitCount, 10) : 0;

    if (count >= 2) {
      setShowSponsorMe(true);
    }

    localStorage.setItem('visitCount', (count + 1).toString());
  };

  const onCloseSponsorMe = (visitCountToSet = 0) => {
    localStorage.setItem('visitCount', visitCountToSet.toString());
    setShowSponsorMe(false);
  };

  return {
    showSponsorMe,
    handleShowSponsorMe,
    onCloseSponsorMe,
  };
};

export default useSponsorMe;
