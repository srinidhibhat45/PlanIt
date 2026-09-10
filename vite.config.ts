import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // host: true binds 0.0.0.0 so phones on the same Wi-Fi can reach it.
  server: { port: 5273, host: true },
  preview: { port: 4273, host: true, strictPort: true },
  build: { target: 'es2022', sourcemap: true },
});
