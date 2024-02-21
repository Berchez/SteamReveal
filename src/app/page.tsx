'use client';
import axios from 'axios';
import Image from 'next/image';
import { useRef } from 'react';

export default function Home() {
  const targetValue = useRef<string | null>();

  const handleGetInfoClick = async (value: string) => {
    try {
      await axios.post('/api/test', {
        target: value,
      });
    } catch (e) {
      console.error(e);
    }
  };

  const onChangeTarget = (value: string) => {
    targetValue.current = value;
  };

  return (
    <div className="h-screen w-screen bg-slate-200">
      <input
        className="w-64 h-8 text-black"
        onChange={({ target }) => onChangeTarget(target.value)}
      />
      <button
        className="w-16 h-8 bg-zinc-700 text-slate-50"
        onClick={() => handleGetInfoClick(targetValue.current ?? '')}
      >
        Get Info
      </button>
    </div>
  );
}
