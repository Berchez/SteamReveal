import React from 'react';

type SearchInputProps = React.InputHTMLAttributes<HTMLInputElement>;

function SearchInput({
  onChange,
  onKeyDown,
  placeholder,
  ...rest
}: SearchInputProps) {
  return (
    <input
      className="w-full md:w-[75%] h-12 px-4 md:text-sm text-xs text-center text-white bg-gray-800/75 border border-gray-500 rounded-full md:focus:focus:text-base focus:text-sm focus:border-blue-500"
      onChange={onChange}
      placeholder={placeholder}
      onKeyDown={onKeyDown}
      {...rest}
    />
  );
}

export default SearchInput;
