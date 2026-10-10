#!/usr/bin/env node
/**
 * Install dsh-macos into a dsh profile. One command, repeatable, reversible.
 *
 *   node tools/install.mjs                     use the desktop profile (or the only one)
 *   node tools/install.mjs --profile work      name the profile explicitly
 *   node tools/install.mjs --home <dir>        a different .dsh/profiles root (portable installs)
 *   node tools/install.mjs --dry-run           report what would change, write nothing
 *   node tools/install.mjs --no-patch          do not touch the application's app.asar
 *   node tools/install.mjs --remove           undo the install (also via uninstall.cmd)
 *
 * What it does, in order:
 *   1. finds the profile and keeps a timestamped copy of its package.json;
 *   2. adds this plugin to `dsh.profile.bundles` and a `link:` dependency on this folder;
 *   3. points `node_modules/dsh-macos` at this folder (a junction, like the plugin manager does);
 *   4. hides the platform's caption buttons by applying the app.asar edit, unless told not to.
 *
 * A full restart of the client is required afterwards: the host half and the archive edit are
 * read when the application starts.
 *
 * `--remove` undoes all four steps, and uninstall.cmd calls it. It exists because the plugin page
 * — the one opened from the sidebar, where the install dialog lives; "Settings → Plugins" lists
 * built-ins only — does not reliably list a plugin that a profile links with `link:`, so there
 * would otherwise be no way to remove it.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  PLUGIN,
  chooseProfile,
  findBundle,
  installPlan,
  linkPlugin,
  mergeManifest,
  removePlan,
  stripManifest,
  profilesRoot,
  unlinkPlugin,
  writeManifest,
} from './profile.mjs'

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { patchBundle } = await import(new URL('../lib/index.js', import.meta.url))

/** Minimal flag parsing: --name value, --flag. */
function parseArgs(argv) {
  const options = { profile: null, home: null, dryRun: false, patch: true, force: false, remove: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile' || arg === '-p') options.profile = argv[++index] ?? null
    else if (arg === '--home') options.home = argv[++index] ?? null
    else if (arg === '--dry-run' || arg === '-n') options.dryRun = true
    else if (arg === '--no-patch') options.patch = false
    else if (arg === '--force' || arg === '-f') options.force = true
    else if (arg === '--remove' || arg === '-r') options.remove = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else {
      console.error(`unknown argument "${arg}" — try --help`)
      process.exit(2)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim())
  process.exit(0)
}

const say = (label, detail) => console.log(`${label.padEnd(10)}: ${detail}`)

console.log(`plugin    : ${pluginDir}`)

let profileDir
try {
  const root = profilesRoot(options.home)
  profileDir = chooseProfile(root, options.profile)
} catch (error) {
  console.error(`error     : ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
say('profile', profileDir)

const manifestFile = path.join(profileDir, 'package.json')
if (!fs.existsSync(manifestFile)) {
  console.error(`error     : ${manifestFile} does not exist — is this really a dsh profile?`)
  process.exit(1)
}
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))

// Pre-flight: everything is checked before anything is written. A profile that already points at a
// different copy of this plugin is a conflict, not an install — rewriting the dependency while the
// junction still points elsewhere would leave the client half-installed.
const linkPath = path.join(profileDir, 'node_modules', PLUGIN)
let linkTarget = null
try {
  linkTarget = fs.readlinkSync(linkPath)
} catch {
  linkTarget = fs.existsSync(linkPath) ? 'directory' : null
}
const plan = options.remove ? removePlan(manifest, pluginDir, linkTarget) : installPlan(manifest, pluginDir, linkTarget)
say('state', plan.detail)
if (plan.action === 'conflict' && !options.force) {
  console.error('')
  if (options.remove) {
    console.error('error     : this profile installs the plugin from somewhere else, so nothing was changed.')
    console.error('            Remove it on the sidebar 插件 page instead. If you really want these profile')
    console.error('            entries dropped anyway, pass --force.')
  } else {
    console.error('error     : this profile already uses a different copy of the plugin.')
    console.error('            Run this from that folder instead, or pass --force to point this profile at')
    console.error('            the copy you are running now.')
  }
  process.exit(1)
}

if (options.remove) {
  // Removal: the profile entries first, then the link, then the archive edit.
  const stripped = stripManifest(manifest)
  if (stripped === null) {
    say('manifest', 'does not list this plugin; nothing to change')
  } else if (options.dryRun) {
    say('manifest', 'would drop the bundle row and the link dependency')
  } else {
    const backup = writeManifest(manifestFile, stripped)
    say('manifest', `updated (backup: ${path.basename(backup)})`)
  }
  const unlinked = options.dryRun ? 'would unlink node_modules/dsh-macos' : unlinkPlugin(profileDir, pluginDir)
  say('link', typeof unlinked === 'string' && unlinked.startsWith('conflict') ? `left alone: it points at ${unlinked.slice(9)}` : unlinked)
  if (options.patch) {
    const bundle = findBundle()
    if (bundle === null) say('caption', 'app.asar not found; nothing to restore')
    else say('caption', options.dryRun ? `would restore ${bundle}` : `${patchBundle('restore', bundle)}  (${bundle})`)
  } else {
    say('caption', 'left as it is (--no-patch)')
  }
  console.log('')
  console.log(options.dryRun ? 'dry run: nothing was written' : 'next      : fully restart the client')
  process.exit(0)
}

if (plan.action === 'noop' && !options.force) {
  say('manifest', 'already lists this plugin; nothing to change')
  say('link', 'unchanged')
  process.exit(0)
}

const merged = mergeManifest(manifest, pluginDir)
if (merged === null) {
  say('manifest', 'already lists this plugin; nothing to change')
} else if (options.dryRun) {
  say('manifest', 'would add the bundle row and the link dependency')
  say('  bundles', [...(merged.dsh.profile.bundles ?? [])].join(', '))
} else {
  const backup = writeManifest(manifestFile, merged)
  say('manifest', `updated (backup: ${path.basename(backup)})`)
}

// --force on an existing foreign link: the junction is replaced, never followed.
if (linkTarget !== null && options.force && !options.dryRun) {
  const removed = unlinkPlugin(profileDir, pluginDir)
  if (removed === 'unlinked' || removed === 'absent') say('link', 'replaced the existing link')
  else {
    console.error(`error     : could not remove the existing node_modules/${PLUGIN} (${removed})`)
    process.exit(1)
  }
}

const linkState = options.dryRun ? 'would link node_modules/dsh-macos' : linkPlugin(profileDir, pluginDir)
if (typeof linkState === 'string' && linkState.startsWith('conflict')) {
  console.error(`error     : node_modules/${PLUGIN} still is not this folder (${linkState.slice(9)})`)
  process.exit(1)
}
say('link', linkState)

if (options.patch) {
  const bundle = findBundle()
  if (bundle === null) {
    say('caption', 'app.asar not found; the platform keeps drawing its caption buttons')
    say('  hint', 'run the app once, or pass the path to tools/bundle-patch.mjs manually')
  } else {
    say('caption', options.dryRun ? `would edit ${bundle}` : `${patchBundle('hide', bundle)}  (${bundle})`)
  }
} else {
  say('caption', 'left alone (--no-patch)')
}

console.log('')
if (options.dryRun) {
  console.log('dry run: nothing was written')
} else {
  console.log('next      : fully restart the client (close it to the tray is not enough)')
  console.log('remove    : the sidebar 插件 page, or uninstall.cmd (tools/install.mjs --remove)')
  console.log(`            if the caption buttons come back on their own, run: node ${path.join(pluginDir, 'tools', 'bundle-patch.mjs')} restore`)
}

