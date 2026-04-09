import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/trends-proxy': {
        target: 'https://trends.google.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/trends-proxy/, ''),
      },
    },
  },
})
