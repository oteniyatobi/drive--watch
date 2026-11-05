import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
    base: '/fleet/',
    plugins: [react(), tailwindcss()],
    // Served as part of the driver site, so it builds into the folder Vercel publishes.
    build: { outDir: '../www/fleet', emptyOutDir: true },
    server: {
        port: 5173,
        proxy: { '/api': 'http://localhost:4000' },
    },
});
