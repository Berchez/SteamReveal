import React from 'react';

export default function RootPage() {
  return (
    <div className="flex flex-col justify-center items-center h-screen bg-gray-100">
      <div className="w-12 h-12 border-4 border-t-blue-500 border-gray-300 rounded-full animate-spin" />
      <p className="mt-4 text-gray-600 text-lg">Loading...</p>
    </div>
  );
}
