import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [{
    // The vendored minified libraries reference sourcemaps that are not committed;
    // strip the reference so vite does not error trying to load them.
    name: 'strip-vendored-sourcemap-refs',
    enforce: 'pre',
    load(id) {
      if (id.endsWith('.min.js') && !id.includes('node_modules')) {
        return readFileSync(id, 'utf-8').replace(/^\/\/#\s*sourceMappingURL=.*$/gm, '');
      }
      return null;
    },
  }],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.js'],
    include: ['test/**/*.test.js'],
    restoreMocks: true,
  },
  resolve: {
    alias: [
      // The real WebSDK is too heavy (and network-bound) for unit tests, so any import of
      // alloy.min.js is redirected to a lightweight mock that mimics the command queue handover.
      {
        find: /^.*alloy\.min\.js$/,
        replacement: fileURLToPath(new URL('./test/mocks/alloy.mock.js', import.meta.url)),
      },
    ],
  },
});
