import react from '@vitejs/plugin-react';
import vercel from 'vite-plugin-vercel';
import helpers from '../helpers.js';

await helpers.callBuild({
  configFile: false,
  mode: 'production',
  root: process.cwd(),
  plugins: [react(), vercel()],
  vercel: {
    prerender() {
      return {
        ssr: {
          // TODO implement dynamicRoutes override
          rewrites: [
            {
              source: 'ssr',
              destination: 'ssr',
              regex: '^/ssr$',
            },
          ],
        },
      };
    },
  },
});
