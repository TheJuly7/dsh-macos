/**
 * Shared helpers for the installer and the maintenance tool.
 *
 * Two things live here: finding the installed application's `app.asar` (so the caption-button edit
 * can be applied or undone from a plain shell), and the profile manifest edits, which are kept as
 * pure functions so they can be tested without touching a real profile.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/** This plugin's package name, which is also its bundle row id and its client module id. */
export const PLUGIN = 'dsh-macos'

/** The installed app.asar, from an explicit path or from the usual install locations. */
export function findBundle(explicit) {
  const tries = []
  if (typeof explicit === 'string' && explicit.length > 0) tries.push(path.resolve(explicit))
  const roots = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['LOCALAPPDATA'] === undefined ? undefined : path.join(process.env['LOCALAPPDATA'], 'Programs'),
  ].filter((value) => value !== undefined && value !== '')
  for (const root of roots) {
    for (const name of ['DeepSeek Harness', 'deepseekHarness', 'deepseek-harness', 'DeepSeekHarness']) {
      tries.push(path.join(root, name, 'resources', 'app.asar'))
    }
  }
  for (const candidate of tries) {
    try {
      if (path.basename(candidate) === 'app.asar' && fs.statSync(candidate).isFile()) return candidate
      // A runtime directory was passed instead: its parent is the bundle.
      const parent = path.dirname(candidate)
      if (fs.statSync(parent).isFile() && path.basename(parent) === 'app.asar') return parent
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/** The directory dsh keeps its profiles in. */
export function profilesRoot(home = null) {
  if (typeof home === 'string' && home.length > 0) return path.resolve(home)
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) {
    return path.join(process.env.DSH_HOME, 'profiles')
  }
  const userProfile = process.env.USERPROFILE ?? process.env.HOME
  if (userProfile === undefined) throw new Error('cannot find the user profile directory; pass --home <dir>')
  return path.join(userProfile, '.dsh', 'profiles')
}

/**
 * Choose the profile to install into.
 *
 * An explicit name always wins. Otherwise `desktop` is used when it exists, because that is the
 * profile the desktop application creates; with exactly one profile present, that one is used.
 */
export function chooseProfile(root, wanted) {
  if (!fs.existsSync(root)) {
    throw new Error(`no profiles directory at ${root} — has the dsh client been started at least once?`)
  }
  const names = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  if (typeof wanted === 'string' && wanted.length > 0) {
    if (!names.includes(wanted)) throw new Error(`profile "${wanted}" does not exist; found: ${names.join(', ') || 'none'}`)
    return path.join(root, wanted)
  }
  if (names.includes('desktop')) return path.join(root, 'desktop')
  if (names.length === 1) return path.join(root, names[0])
  throw new Error(`cannot tell which profile to use; pass --profile <name> (found: ${names.join(', ') || 'none'})`)
}

/** The `link:` specifier that points at a folder, with forward slashes so it is portable. */
export function linkSpecifier(pluginDir) {
  return `link:${path.resolve(pluginDir).replace(/\\/g, '/')}`
}

/** Read the value at `path` in an object, or null. */
function at(object, keys) {
  let node = object
  for (const key of keys) {
    if (typeof node !== 'object' || node === null) return null
    node = node[key]
  }
  return node ?? null
}

/**
 * Decide what an install would do, without touching anything.
 *
 * A profile that already points at a *different* copy of this plugin is a conflict, not an
 * install: rewriting the dependency while the junction still points elsewhere leaves the client
 * half-installed. `linkTarget` is whatever `node_modules/<plugin>` resolves to: a path, the
 * string 'directory' when it is a real folder, or null when there is nothing there.
 */
export function installPlan(manifest, pluginDir, linkTarget) {
  const desired = linkSpecifier(pluginDir)
  const declared = at(manifest, ['dependencies', PLUGIN])
  const listed = Array.isArray(at(manifest, ['dsh', 'profile', 'bundles']))
    ? manifest.dsh.profile.bundles.includes(PLUGIN)
    : false
  if (declared !== null && declared !== desired) {
    return { action: 'conflict', detail: `the profile's dependency already points at ${declared}` }
  }
  if (linkTarget === 'directory') {
    return { action: 'conflict', detail: `node_modules/${PLUGIN} is a real directory, not a link` }
  }
  if (typeof linkTarget === 'string' && path.resolve(linkTarget) !== path.resolve(pluginDir)) {
    return { action: 'conflict', detail: `node_modules/${PLUGIN} points at ${linkTarget}` }
  }
  if (listed && declared === desired) return { action: 'noop', detail: 'already installed from this folder' }
  return { action: 'install', detail: 'adds the bundle row, the link dependency and the junction' }
}

/** Add this plugin to a profile manifest.
 * @returns a new manifest, or null when nothing had to change.
 */
export function mergeManifest(manifest, pluginDir) {
  const next = JSON.parse(JSON.stringify(manifest))
  next.dsh = next.dsh ?? {}
  next.dsh.profile = next.dsh.profile ?? {}
  const bundles = Array.isArray(next.dsh.profile.bundles) ? next.dsh.profile.bundles : []
  const dependencies = typeof next.dependencies === 'object' && next.dependencies !== null ? next.dependencies : {}
  // pnpm's link protocol, with forward slashes so the value stays valid on any platform.
  const specifier = linkSpecifier(pluginDir)
  const alreadyListed = bundles.includes(PLUGIN)
  const alreadyLinked = dependencies[PLUGIN] === specifier
  if (alreadyListed && alreadyLinked) return null
  next.dsh.profile.bundles = alreadyListed ? bundles : [...bundles, PLUGIN]
  next.dependencies = { ...dependencies, [PLUGIN]: specifier }
  return next
}

/** Write JSON the way the profile's own files are written, after keeping a timestamped copy. */
export function writeManifest(file, manifest) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${file}.bak-${stamp}`
  if (fs.existsSync(file)) fs.copyFileSync(file, backup)
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return backup
}

/**
 * Point `node_modules/<plugin>` at this folder.
 *
 * A directory junction on Windows, a symlink elsewhere, which is what the plugin manager itself
 * would create for a `link:` dependency. An existing entry that points somewhere else is left
 * alone and reported: replacing someone's installation is not this tool's decision.
 */
export function linkPlugin(profileDir, pluginDir) {
  const target = path.join(profileDir, 'node_modules', PLUGIN)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  let existing = null
  try {
    existing = fs.readlinkSync(target)
  } catch {
    /* not a link, or missing */
  }
  if (existing !== null) {
    if (path.resolve(existing) === path.resolve(pluginDir)) return 'unchanged'
    return `conflict:${existing}`
  }
  if (fs.existsSync(target)) return 'conflict:directory'
  fs.symlinkSync(pluginDir, target, process.platform === 'win32' ? 'junction' : 'dir')
  return 'linked'
}

/** Remove the link, but only when it is this plugin's own. */
export function unlinkPlugin(profileDir, pluginDir) {
  const target = path.join(profileDir, 'node_modules', PLUGIN)
  let existing = null
  try {
    existing = fs.readlinkSync(target)
  } catch {
    return fs.existsSync(target) ? 'conflict:directory' : 'absent'
  }
  if (path.resolve(existing) !== path.resolve(pluginDir)) return `conflict:${existing}`
  // A junction is removed with rmdir: deleting through it would empty the plugin folder itself.
  fs.rmdirSync(target)
  return 'unlinked'
}
