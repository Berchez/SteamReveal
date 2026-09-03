import type { Config } from 'jest';
import nextJest from 'next/jest.js';

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files in your test environment
  dir: './',
});

// Add any custom config to be passed to Jest
const config: Config = {
  coverageProvider: 'v8',
  testEnvironment: 'jsdom',
  moduleNameMapper: {
    '^@vercel/analytics$': '<rootDir>/__mocks__/@vercel/analytics.js',
    '^@vercel/analytics/react$':
      '<rootDir>/__mocks__/@vercel/analytics-react.js',
    '^@vercel/speed-insights/next$':
      '<rootDir>/__mocks__/@vercel/speed-insights-next.js',
    // next/jest already resolves tsconfig paths for runtime imports; mapping
    // here too lets jest.mock('@/...') strings resolve (used by CheaterReport
    // and its test).
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testPathIgnorePatterns: ['<rootDir>/node_modules/', '<rootDir>/e2e/'],
  // Add more setup options before each test is run
  // setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
};

// createJestConfig is exported this way to ensure that next/jest can load the Next.js config which is async
export default createJestConfig(config);
