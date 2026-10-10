import React from 'react';

interface GradientButtonProps {
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  children: React.ReactNode;
}

/**
 * Neon gradient-border button for the card-level primary actions
 * (currently the CS2 anticheat trigger in MyUserSection): extracted —
 * not duplicated — so a style tweak lands everywhere at once. Neutral
 * by design (no menu semantics): popover triggers with their own
 * a11y contract (like ShareBar's) bring their own button.
 */
function GradientButton({ onClick, disabled, children }: GradientButtonProps) {
  return (
    <div className="relative rounded-xl p-[1px] w-fit inline-flex items-center justify-center group">
      <div
        className="absolute inset-0 rounded-xl bg-[length:200%_200%] animate-gradient-spin"
        style={{
          backgroundImage:
            'linear-gradient(90deg, #ff8ae2, #ff1bce, #ea00ff, #9a64ff, #3d5afe, #ae00ff, #ff8ae2, #ff1bce, #ea00ff)',
        }}
        aria-hidden="true"
      />
      <button
        onClick={onClick}
        disabled={disabled}
        className="relative z-10 px-4 py-2 text-sm font-medium text-white rounded-xl bg-[#1c0029d7] backdrop-blur-md border border-transparent group-hover:shadow-[0_0_20px_rgba(255,100,249,0.5)] transition duration-200 disabled:cursor-not-allowed disabled:opacity-60 disabled:group-hover:shadow-none"
        type="button"
      >
        {children}
      </button>
    </div>
  );
}

export default GradientButton;
