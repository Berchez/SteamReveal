'use client';

import React from 'react';
import { useTranslations } from 'next-intl';

// The section headings live in their own component for one reason: the two
// player sections are loaded with next/dynamic (they are heavy - the map
// iframe, the friend cards), and while their chunk is still in flight
// next/dynamic renders the `loading` fallback INSTEAD of the server-rendered
// markup. With no fallback the whole section vanished from the DOM and came
// back when the chunk landed, and on the player page that unmount/remount
// moved the ~6500px friends block and banked the biggest layout shift of the
// page. The fallback therefore renders exactly the same heading the section
// itself renders, so the swap is height-neutral (and the section's own
// skeleton still owns the "data is loading" look).
//
// The translation keys are the two section headings under the `Index`
// namespace; they are spelled out here so the translator stays strictly
// typed.
type SectionTitleProps = {
  translationKey: 'friendsIRL' | 'userPossibleLocation';
};

export default function SectionTitle({ translationKey }: SectionTitleProps) {
  const translator = useTranslations('Index');
  return (
    <h1 className="text-2xl font-bold text-gray-100">
      {translator(translationKey)}
    </h1>
  );
}
