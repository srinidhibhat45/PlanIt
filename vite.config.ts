import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // host: true binds 0.0.0.0 so phones on the same Wi-Fi can reach it.
  server: { port: 5273, host: true },
  preview: { port: 4273, host: true, strictPort: true },
  build: {
    target: 'es2022',
    // The maps are ~2.2 MB and would be published alongside the site, so a
    // deploy build leaves them out. `SOURCEMAP=1 npm run build` brings them
    // back when you need to read a production stack trace.
    sourcemap: process.env.SOURCEMAP === '1',
  },
});
