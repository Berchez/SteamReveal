module.exports = {
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'next',
    'next/core-web-vitals',

    'plugin:react/recommended',
    'airbnb',
    'prettier',
    'plugin:import/recommended',
  ],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'react', 'react-hooks', 'prettier'],
  root: true,
  env: {
    browser: true,
    amd: true,
    node: true,
  },
  rules: {
    // SEO Rules
    'jsx-a11y/alt-text': 'error',
    'jsx-a11y/anchor-is-valid': 'error',
    'jsx-a11y/heading-has-content': 'error',
    'jsx-a11y/html-has-lang': 'error',
    'jsx-a11y/no-redundant-roles': 'error',
    'jsx-a11y/aria-role': 'error',
    'jsx-a11y/label-has-associated-control': 'error',
    'jsx-a11y/iframe-has-title': 'error',
    'jsx-a11y/media-has-caption': 'warn',
    'jsx-a11y/anchor-has-content': 'error',

    // Best practices Rules
    '@next/next/no-img-element': 'error',
    '@next/next/no-page-custom-font': 'warn',

    // General Rules
    'nu-undef': 'off',
    'react/jsx-filename-extension': 'off',
    'import/extensions': 'off',
    camelcase: 'off',
    'react/require-default-props': 'off',
    'react/prop-types': 'off',
    'react/jsx-props-no-spreading': 'off',
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['error'],
  },
  ignorePatterns: [
    '**/*.spec.ts',
    '**/*.spec.tsx',
    '**/*.test.ts',
    '**/*.test.tsx',
  ],
};
