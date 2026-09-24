import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src'), '@assets': path.resolve(import.meta.dirname, 'attached_assets') } },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    // CardProgress deliberately waits up to 4s for the cloud before it will
    // call a card "New", so any test that exercises hydration needs headroom.
    testTimeout: 20_000,
  },
});
