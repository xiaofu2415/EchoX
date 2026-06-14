import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json'; // 引入根目录的 manifest

export default defineConfig({
  base: './', // Use relative paths for built assets to ensure they load correctly in extension pages
  plugins: [
    react(),
    crx({ manifest }), // 让 crx 插件接管清单文件的编译和拷贝
  ],
  build: {
    emptyOutDir: true,
    rollupOptions: {
      input: {
        offscreen: 'offscreen.html'
      }
    }
  },
});
