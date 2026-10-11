import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  // Worker-only dependencies must be ready before the first feature is opened;
  // otherwise Vite's optimizer can reload the active editor during development.
  optimizeDeps: {
    include: [
      'pdf-lib',
      '@huggingface/transformers',
      'onnxruntime-web',
      '@mintplex-labs/piper-tts-web',
      'tesseract.js',
      'pinyin-ime/dictionary/google_pinyin_dict',
    ],
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 1800 },
});
