#!/usr/bin/env node
/**
 * Inspect or undo the one edit this plugin makes outside its own directory.
 *
 * To remove Windows' caption buttons for good, dsh-macos renames two strings of equal length
 * inside the installed `app.asar`: the window option that enables Electron's title-bar overlay,
 * and the IPC channel the preload reports the title-bar colours on. In normal use the plugin
 * applies that edit when it loads and undoes it when it is unloaded, so this tool is only needed
 * to check the current state, to undo the edit after an app was killed before it could clean up,
 * or to remove it by hand.
 *
 *   node tools/bundle-patch.mjs                      report the current state
 *   node tools/bundle-patch.mjs hide                 remove the caption buttons
 *   node tools/bundle-patch.mjs restore              put the option and the channel back
 *   node tools/bundle-patch.mjs status <app.asar>    name the bundle explicitly
 *
 * Without an explicit path the installed application is looked for in the usual places. Writing
 * inside `app.asar` needs permission for the application's own folder; if the app lives under
 * `Program Files`, run this once from an elevated shell. `DSH_MACOS_NO_BUNDLE_PATCH=1` switches
 * the whole mechanism off, here and in the app.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { findBundle } from './profile.mjs'

const { bundleStatus, patchBundle } = await import(new URL('../lib/index.js', import.meta.url))

const args = process.argv.slice(2)
// `hide`, `restore`, `status <path>`, or just `<path>` — the action defaults to reporting.
const action = ['status', 'hide', 'restore'].includes(args[0]) ? args[0] : 'status'
const explicit = (['status', 'hide', 'restore'].includes(args[0]) ? args[1] : args[0]) ?? undefined
const bundle = findBundle(explicit)

console.log(`bundle  : ${bundle ?? '(not found — pass the app.asar path explicitly)'}`)
if (bundle === null) process.exit(2)

if (action === 'status') {
  console.log(`state   : ${bundleStatus(bundle)}`)
  console.log('          "already" = the caption buttons are hidden; "renamed" = the platform still draws them')
} else {
  console.log(`action  : ${action}`)
  console.log(`result  : ${patchBundle(action, bundle)}`)
}
