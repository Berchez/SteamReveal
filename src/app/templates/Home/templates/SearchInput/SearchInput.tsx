import { useTranslations } from 'next-intl';
import React from 'react';

type SearchInputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  onSearch?: () => void;
};

function SearchInput({
  onChange,
  onKeyDown,
  placeholder,
  onSearch,
  ...rest
}: SearchInputProps) {
  const translator = useTranslations('General');
  return (
    <div className="relative w-full md:w-[75%] m-auto">
      <input
        className="w-full h-12 pl-4 pr-24 text-center text-white text-xs md:text-sm bg-gray-800/75 border border-gray-500 rounded-full placeholder:text-gray-400 focus:border-blue-500 focus:outline-none"
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        {...rest}
      />
      <button
        type="button"
        onClick={onSearch}
        className="absolute right-2 top-1/2 -translate-y-1/2 h-9 px-4 rounded-full bg-purple-500 hover:bg-purple-600/90 text-white flex items-center gap-2 text-xs md:text-sm"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
        >
          <circle cx="11" cy="11" r="8"></circle>
          <path d="m21 21-4.3-4.3"></path>
        </svg>
        <span>{translator('search')}</span>
      </button>
    </div>
  );
}

export default SearchInput;
