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
  // Redirects the ops-log layer (src/lib/opsLog.ts) into a per-file tmpdir
  // (created + cleaned in jest.setup.js) so the suite never touches the
  // repo's real .data/logs. AfterEnv — not setupFiles — because the layer
  // resolves OPS_LOG_DIR lazily per write; nothing needs it at import
  // time, and AfterEnv supports the afterAll cleanup.
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
};

// createJestConfig is exported this way to ensure that next/jest can load the Next.js config which is async
export default createJestConfig(config);
