import { useCallback, useState } from 'react';

const useSupportMe = () => {
  const [showSupportMe, setShowSupportMe] = useState(false);

  const getCurrentCount = useCallback(() => {
    const count = localStorage.getItem('supportMeVisitCount');
    return count ? parseInt(count, 10) : 0;
  }, []);

  const handleShowSupportMe = useCallback(
    (value: number) => {
      const current = getCurrentCount();
      const updated = current + value;
      if (updated >= 10) {
        setShowSupportMe(true);
        return;
      }
      localStorage.setItem('supportMeVisitCount', updated.toString());
    },
    [getCurrentCount],
  );

  const onCloseSupportMe = useCallback((supportMeVisitCountToSet = 0) => {
    localStorage.setItem(
      'supportMeVisitCount',
      supportMeVisitCountToSet.toString(),
    );
    setShowSupportMe(false);
  }, []);

  return {
    showSupportMe,
    handleShowSupportMe,
    onCloseSupportMe,
  };
};

export default useSupportMe;
