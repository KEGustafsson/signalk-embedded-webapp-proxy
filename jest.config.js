/** @type {import('jest').Config} */
module.exports = {
  collectCoverageFrom: ['src/**/*.{ts,tsx}'],
  coverageThreshold: {
    global: { branches: 80, functions: 80, lines: 80, statements: 80 },
  },
  projects: [
    {
      displayName: 'plugin',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/test/index.test.ts'],
    },
    {
      displayName: 'ui',
      preset: 'ts-jest',
      testEnvironment: 'jsdom',
      testMatch: ['<rootDir>/test/AppPanel.test.tsx'],
    },
  ],
}
