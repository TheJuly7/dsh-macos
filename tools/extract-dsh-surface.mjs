/**
 * extract-dsh-surface.mjs — snapshot what this plugin binds to, from an installed
 * DeepSeek Harness build.
 *
 *   classes   the CSS-module class names the client actually ships, per package. They
 *             are compressed and build-specific (`_2H3hWW_root`), so a skin must be
 *             checked against a real build rather than guessed at.
 *   slots     every slot name the installed client composes.
 *   services  every client service a plugin may inject.
 *
 * verify.mjs compares the plugin against this file, so a typo — or a surface a dsh
 * release changed — fails the build instead of failing silently in the browser.
 *
 * Usage:
 *   node tools/extract-dsh-surface.mjs                 # auto-detect the install
 *   node tools/extract-dsh-surface.mjs <app.asar path>
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

const CANDIDATES = [
  process.argv[2],
  process.env.DSH_ASAR,
  'D:/developSoftware/deepseekHarness/resources/app.asar',
  'C:/Program Files/DeepSeek Harness/resources/app.asar',
  path.join(process.env.LOCALAPPDATA || '', 'Programs/DeepSeek Harness/resources/app.asar'),
].filter(Boolean)

const asarPath = CANDIDATES.find((candidate) => {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
})

if (!asarPath) {
  console.error('Could not find app.asar. Pass its path as the first argument or set DSH_ASAR.')
  for (const candidate of CANDIDATES) console.error('  - ' + candidate)
  process.exit(1)
}

async function readAsarHeader(file) {
  const handle = await fsp.open(file, 'r')
  try {
    const sizeBuf = Buffer.alloc(8)
    await handle.read(sizeBuf, 0, 8, 0)
    const headerSize = sizeBuf.readUInt32LE(4)
    const headerBuf = Buffer.alloc(headerSize)
    await handle.read(headerBuf, 0, headerSize, 8)
    return {
      header: JSON.parse(headerBuf.subarray(headerBuf.indexOf(0x7b)).toString('utf8')),
      baseOffset: 8 + headerSize,
    }
  } finally {
    await handle.close()
  }
}

async function readAsarFile(file, baseOffset, entry) {
  const handle = await fsp.open(file, 'r')
  try {
    const buf = Buffer.alloc(entry.size)
    await handle.read(buf, 0, entry.size, baseOffset + Number(entry.offset))
    return buf.toString('utf8')
  } finally {
    await handle.close()
  }
}

function findEntry(node, target, prefix = '') {
  for (const [name, value] of Object.entries(node.files || {})) {
    const p = prefix + '/' + name
    if (value.files) {
      const hit = findEntry(value, target, p)
      if (hit) return hit
    } else if (p === target) {
      return value
    }
  }
  return null
}

const { header, baseOffset } = await readAsarHeader(asarPath)

const runtimePkg = findEntry(header, '/dsh/package.json')
const dshVersion = runtimePkg ? JSON.parse(await readAsarFile(asarPath, baseOffset, runtimePkg)).version : 'unknown'

// The packages that draw the window chrome and the sidebar rows.
const CLIENT_PACKAGES = [
  'dsh-client-ui-layout',
  'dsh-client-ui-sidebar',
  'dsh-client-ui-theme',
  'dsh-client-ui-slots',
  'dsh-client-modules',
]
const classes = {}
const slots = new Set()
const services = new Set()

for (const pkg of CLIENT_PACKAGES) {
  const entry =
    findEntry(header, `/dsh/node_modules/@deepseek-ai/${pkg}/lib/client.js`) ||
    findEntry(header, `/dsh/node_modules/@deepseek-ai/${pkg}/lib/index.js`)
  if (!entry) continue
  const source = await readAsarFile(asarPath, baseOffset, entry)

  // The compiled CSS-module sheet lives in the longest string literals.
  const css = [...source.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'))
    .filter((value) => value.includes('{') && value.includes('}') && value.length > 400)
    .join('\n')
  const names = new Set()
  for (const m of css.matchAll(/\.([A-Za-z0-9_-]+_[A-Za-z][A-Za-z0-9_-]*)/g)) names.add(m[1])
  if (names.size > 0) classes[pkg] = [...names].sort()

  for (const m of source.matchAll(/"([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)"\s*:\s*\{\s*kind:\s*"(?:single|list|keyed)"/g)) slots.add(m[1])
  for (const m of source.matchAll(/slots\.(?:inject|entries|register)\(\s*"([a-z][A-Za-z0-9.]*)"/g)) slots.add(m[1])
  for (const m of source.matchAll(/(?:reflect\.)?provide\(\s*"([a-zA-Z][A-Za-z0-9]*)"/g)) services.add(m[1])
  for (const m of source.matchAll(/(?:const|let|var)\s+inject\s*=\s*\[([^\]]*)\]/g)) {
    for (const name of m[1].matchAll(/"([a-zA-Z][A-Za-z0-9]*)"/g)) services.add(name[1])
  }
}

const surfaceFile = path.join(repoRoot, 'surface', `dsh-surface-${dshVersion}.json`)
await fsp.mkdir(path.dirname(surfaceFile), { recursive: true })
await fsp.writeFile(
  surfaceFile,
  JSON.stringify(
    { dshVersion, extractedFrom: 'app.asar', classes, slots: [...slots].sort(), services: [...services].sort() },
    null,
    1,
  ) + '\n',
)

console.log('app.asar     : ' + asarPath)
console.log('dsh version  : ' + dshVersion)
for (const [pkg, names] of Object.entries(classes)) console.log(`classes      : ${pkg} -> ${names.length}`)
console.log('slots        : ' + slots.size)
console.log('services     : ' + services.size)
console.log('surface      : ' + path.relative(repoRoot, surfaceFile).replace(/\\/g, '/'))
