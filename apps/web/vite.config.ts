import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 开发时前端跑在 5173，/api 代理到 Harness 的 webserver（默认 3000）
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/api': { target: `http://127.0.0.1:${process.env.PORT ?? 3000}`, changeOrigin: true },
        },
    },
    build: { outDir: 'dist', emptyOutDir: true },
})
