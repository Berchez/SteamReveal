'use client';

import React from 'react';
import { ToastContainer } from 'react-toastify';

interface ToastProviderProps {
  children: React.ReactNode;
}

export default function ToastProvider({ children }: ToastProviderProps) {
  return (
    <>
      {children}
      <ToastContainer theme="dark" />
    </>
  );
}
