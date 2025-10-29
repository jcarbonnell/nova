require('dotenv').config();

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.(ts|tsx|js|jsx)$': 'babel-jest'  // Babel for all (TS/JS/ESM)
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(@noble)/)'  // Ensure @noble transpiled
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  testTimeout: 30000,
  forceExit: true,
  detectOpenHandles: false
};