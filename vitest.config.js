import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// `npm run test:dist` runs the same suite against the minified build: what a page
// loaded from packstub/holler or packstub/filament-holler actually runs.
const dist = process.env.HOLLER_DIST === '1'

export default defineConfig({
    resolve: {
        alias: dist
            ? [{ find: /^\.\.\/src\/(index|widget)\.js$/, replacement: fileURLToPath(new URL('./dist/$1.js', import.meta.url)) }]
            : [],
    },
})
