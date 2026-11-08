import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ command, isPreview }) => ({
  plugins: [react()],
  // GitHub Pages serves the site at https://thhheo98.github.io/windlass/, so
  // builds and `vite preview` use that path; the dev server stays at /.
  base: command === 'build' || isPreview ? '/windlass/' : '/',
}))
