// Builds dist/: the engine, the widget and its stylesheet, minified, for a page that loads
// them straight from a server (packstub/holler and packstub/filament-holler copy these).
// A bundler takes src/ instead, through the package exports, and minifies on its own.
//
//   node scripts/build.mjs          write dist/
//   node scripts/build.mjs --check  fail when dist/ is not what src/ builds to
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const banner = `/*! @packstub/holler ${version} | MIT | https://github.com/packstub/holler-js */`
const check = process.argv.includes('--check')

const result = await build({
    absWorkingDir: root,
    entryPoints: ['src/index.js', 'src/widget.js', 'src/widget.css'],
    outdir: 'dist',
    // Two modules, as in src/: the widget imports the engine beside it, so a page that
    // loads both (or the engine alone) gets one copy of it.
    bundle: true,
    external: ['./index.js'],
    format: 'esm',
    // Syntax is left as written up to ES2020 (optional chaining, `??`), which every browser
    // with today's WebRTC runs.
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    banner: { js: banner, css: banner },
    write: false,
})

let stale = false

for (const file of result.outputFiles) {
    if (check) {
        const current = await readFile(file.path, 'utf8').catch(() => null)

        if (current !== file.text) {
            console.error(`${file.path} is out of date: run npm run build`)
            stale = true
        }

        continue
    }

    await mkdir(dirname(file.path), { recursive: true })
    await writeFile(file.path, file.text)
    console.log(`${file.path.slice(root.length + 1)}  ${(file.contents.length / 1024).toFixed(1)} kB`)
}

process.exit(stale ? 1 : 0)
