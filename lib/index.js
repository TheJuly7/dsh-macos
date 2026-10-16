/**
 * dsh-macos — host half.
 *
 * The window controls. macOS draws its traffic lights and lets the app place them; Windows
 * draws caption buttons in the top right instead, which this plugin hides. So the three dots
 * in the reference are drawn by the browser half and driven from here, because the renderer
 * cannot reach the OS window at all:
 *
 *   spawn(node, ['--expose-internals', '<runtime>/@deepseek-ai/dsh-desktop-host/lib/index.js', runtimeDir, ...],
 *         desktopNodeEnvironment(...))   // ELECTRON_RUN_AS_NODE=1
 *
 * The profile runs in that Node-mode child, so `import('electron')` yields no BrowserWindow
 * and the preload's product API exposes no minimise or maximise. The window belongs to this
 * process's parent (`process.ppid`), so the commands go through Win32 with Koffi — the FFI
 * binding dsh already ships for its own Windows work — and every action is confined to a
 * visible window owned by that parent. A caller sends one action name and nothing else: no
 * handle, no path, no window. The route is on the loopback-only web server, POST only, with
 * the body capped at 1 KB.
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

export const name = 'dsh-macos'

/** Exact route the browser half posts window commands to. */
export const WINDOW_ROUTE = '/plugins/dsh-macos/window'

/** Where the plugin reports what it did, at the default verbosity. */
export const LOG_PREFIX = '[dsh-macos]'

function log(line) {
  try {
    process.stderr.write(`${LOG_PREFIX} ${line}\n`)
  } catch {
    /* logging must never be the reason something fails */
  }
}

/* ---------------------------------------------------------------------------
 * The two edits that make the platform's caption buttons genuinely go away.
 *
 * Painting them transparent is not enough: they stay hit-testable, and Chromium repaints its
 * overlay art (its close button in particular) on the next frame, so the platform's own
 * hover state keeps coming back. The only real switch is the window option that enables the
 * overlay at all — and this plugin cannot set that option, because the desktop profile runs
 * in a Node-mode child rather than the main process. What it can do is rename the option in
 * the application's own bundle, which Electron then ignores.
 *
 * Renaming it alone crashes startup, and the reason is worth recording: the desktop preload
 * reports the sidebar's colours over `dsh-desktop:windows-appearance`, and the main process
 * hands them to `mainWindow.setTitleBarOverlay(...)`, which throws
 * "Titlebar overlay is not enabled" once the option is gone. So the second edit renames that
 * channel in the preload. The main process still registers its handler for the original name;
 * it simply never fires, because nothing sends on it any more.
 *
 * Both edits are same-length renames inside the installed app.asar, so no offset or size in
 * the archive header has to be rewritten, and both are reverted on unload. Only the main
 * window's use of the option is touched — the welcome window keeps its own controls.
 *
 * Each rename carries a marker: text that must sit just past the occurrence for it to be a
 * candidate. The channel name also appears in main.js, and a future dsh build could name it
 * anywhere; the marker keeps the edit pinned to the preload's IPC map, and it gates the
 * "already applied" answer too, so a coincidental match cannot be mistaken for this edit.
 */
const OPTION_FROM = 'titleBarOverlay'
const OPTION_TO = 'titleBarOverlaX'
const OPTION_MARKER = 'chromeFallbackFill'
const CHANNEL_FROM = 'dsh-desktop:windows-appearance'
const CHANNEL_TO = 'dsh-desktop:windows-appearancX'
const CHANNEL_MARKER = 'windowsMenu: "dsh-desktop:windows-menu"'

/** The two files in the bundle, and what is renamed in each. */
const PATCHES = [
  { file: '/lib/main.js', from: OPTION_FROM, to: OPTION_TO, marker: OPTION_MARKER, label: 'window option' },
  { file: '/lib/preload-app.cjs', from: CHANNEL_FROM, to: CHANNEL_TO, marker: CHANNEL_MARKER, label: 'appearance channel' },
]

/**
 * Rename one same-length occurrence inside an image, then report where.
 *
 * Exported so the verifier can exercise it on a synthetic image. The marker requirement is
 * what keeps the welcome window's own use of the option untouched.
 *
 * @param image - a writable buffer.
 * @param from - the text to find.
 * @param to - the replacement, which must be the same length.
 * @param marker - text that must appear just after the match, or null.
 * @returns { index, status } where status is renamed | already | not-found | length-mismatch.
 */
export function renameOnce(image, from, to, marker = null) {
  if (from.length !== to.length) return { index: -1, status: 'length-mismatch' }
  // With a marker, only the occurrence it identifies is a candidate — an unmarked one belongs
  // to something else and must be left exactly as it is.
  const locate = (needle) => {
    let cursor = 0
    while (cursor < image.length) {
      const at = image.indexOf(needle, cursor)
      if (at < 0) return -1
      if (marker === null) return at
      const context = image.subarray(at, Math.min(image.length, at + needle.length + 400)).toString('latin1')
      if (context.includes(marker)) return at
      cursor = at + 1
    }
    return -1
  }
  const at = locate(from)
  if (at >= 0) {
    image.write(to, at, to.length, 'latin1')
    return { index: at, status: 'renamed' }
  }
  return { index: -1, status: locate(to) >= 0 ? 'already' : 'not-found' }
}

/**
 * Candidates for the app.asar a process was launched from, derived from its arguments.
 *
 * The desktop shell spawns its host child as
 *
 *   node --expose-internals <…>/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js \
 *        <runtimeDir> <projectDir> [pnpm, nodeBin]
 *
 * so the bundle is neither argv[2] — that is the host entry script — nor reliably beside
 * process.execPath, which is the node binary. Both the entry path and the runtime directory are
 * therefore inspected: the entry names the archive, and the runtime directory sits inside it.
 *
 * @param argv - the arguments after the executable.
 * @returns absolute candidate paths, most likely first.
 */
export function asarFromArgv(argv) {
  const candidates = []
  for (const value of argv) {
    if (typeof value !== 'string' || value.length === 0) continue
    // Flags are not paths: treating --expose-internals as a directory yielded the working
    // directory as a candidate.
    if (value.startsWith('-')) continue
    const marker = value.indexOf('.asar')
    if (marker >= 0) {
      candidates.push(value.slice(0, marker + '.asar'.length))
      continue
    }
    // A directory argument: the archive is one or two levels above a runtime directory. Only
    // absolute paths are considered.
    if (!/^([A-Za-z]:[\\/]|\/)/.test(value)) continue
    candidates.push(path.join(value, '..'), path.join(value, '..', '..'))
  }
  return candidates.map((candidate) => path.resolve(candidate))
}

/**
 * Locate app.asar for the running installation.
 * @param override - an explicit app.asar path, used by the maintenance tool.
 */
function bundlePath(override = null) {
  const candidates = [
    typeof override === 'string' && override.length > 0 ? path.resolve(override) : null,
    ...asarFromArgv(process.argv.slice(1)),
    path.join(path.dirname(process.execPath), 'resources', 'app.asar'),
  ].filter((value) => value !== null)
  for (const candidate of candidates) {
    if (path.basename(candidate) !== 'app.asar') continue
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/** Read the archive header and return the byte range of one entry. */
function entryRange(file, wanted) {
  const handle = fs.openSync(file, 'r')
  try {
    const size = Buffer.alloc(8)
    fs.readSync(handle, size, 0, 8, 0)
    const headerSize = size.readUInt32LE(4)
    const header = Buffer.alloc(headerSize)
    fs.readSync(handle, header, 0, headerSize, 8)
    const parsed = JSON.parse(header.subarray(header.indexOf(0x7b)).toString('utf8'))
    const base = 8 + headerSize
    const parts = wanted.split('/').filter((part) => part.length > 0)
    let node = parsed
    for (const part of parts) {
      node = node.files === undefined ? undefined : node.files[part]
      if (node === undefined) return null
    }
    if (node.offset === undefined || node.size === undefined) return null
    return { start: base + Number(node.offset), size: Number(node.size) }
  } catch {
    return null
  } finally {
    fs.closeSync(handle)
  }
}

/**
 * Apply or revert both bundle edits.
 *
 * Set `DSH_MACOS_NO_BUNDLE_PATCH=1` to leave the application's bundle alone; the window then
 * keeps whatever caption buttons the platform draws.
 *
 * @param mode - 'hide' to rename both, 'restore' to rename them back.
 * @returns a short status per edit, for the log.
 */
export function patchBundle(mode, override = null) {
  if (process.env.DSH_MACOS_NO_BUNDLE_PATCH === '1') return 'disabled'
  const file = bundlePath(override)
  if (file === null) return 'bundle-not-found'

  let handle
  try {
    handle = fs.openSync(file, 'r+')
  } catch {
    return 'read-only'
  }
  try {
    const report = []
    for (const patch of PATCHES) {
      const range = entryRange(file, patch.file)
      if (range === null) {
        report.push(`${patch.label}=no-entry`)
        continue
      }
      const image = Buffer.alloc(range.size)
      fs.readSync(handle, image, 0, range.size, range.start)
      const from = mode === 'restore' ? patch.to : patch.from
      const to = mode === 'restore' ? patch.from : patch.to
      const result = renameOnce(image, from, to, patch.marker)
      if (result.status === 'renamed') fs.writeSync(handle, image, result.index, to.length, range.start + result.index)
      report.push(`${patch.label}=${result.status}`)
    }
    return report.join(' ')
  } catch (error) {
    return 'failed:' + (error instanceof Error ? error.message : String(error))
  } finally {
    fs.closeSync(handle)
  }
}

/**
 * Which results mean "the application directory refused the write".
 *
 * The first is the open failing outright, which is the ordinary case when the client was installed
 * into a folder only administrators may write. The second covers a write that failed part-way for
 * the same reason.
 */
export function needsElevation(result) {
  return result === 'read-only' || /failed:.*(EACCES|EPERM|EBUSY)/.test(result)
}

/** What this session's load did to the archive, reported to the browser half. */
let patchOutcome = { changed: false, blocked: false }

/** The last archive outcome, for the client notice and for tests. */
export function patchReport() {
  return { ...patchOutcome }
}

/**
 * Ask Windows for one elevation, and let the shipped tool apply the edit.
 *
 * Nothing is elevated silently: Windows shows its own consent prompt, and only this plugin's own
 * tool is started, with the archive path resolved from the running application rather than from any
 * caller. If consent is refused the launch throws and nothing happens — which is why the caller
 * still logs the way to do it by hand.
 */
function elevatePatch() {
  const file = bundlePath()
  if (file === null) return false
  let tool
  try {
    tool = fileURLToPath(new URL('../tools/bundle-patch.mjs', import.meta.url))
  } catch {
    return false
  }
  const quoted = (value) => `'${value.replaceAll("'", "''")}'`
  const command = `Start-Process -FilePath ${quoted(process.execPath)} -ArgumentList ${quoted(tool)},'hide',${quoted(file)} -Verb RunAs -WindowStyle Hidden`
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return true
  } catch (error) {
    log(`elevation: could not be requested (${error instanceof Error ? error.message : String(error)})`)
    return false
  }
}

/** Read both edits without changing anything, for the maintenance tool. */
export function bundleStatus(override = null) {
  const file = bundlePath(override)
  if (file === null) return 'bundle-not-found'

  let handle
  try {
    handle = fs.openSync(file, 'r')
  } catch {
    return 'unreadable'
  }
  try {
    const report = []
    for (const patch of PATCHES) {
      const range = entryRange(file, patch.file)
      if (range === null) {
        report.push(`${patch.label}=no-entry`)
        continue
      }
      const image = Buffer.alloc(range.size)
      fs.readSync(handle, image, 0, range.size, range.start)
      // renameOnce only reports where the rename would go; the caller writes. Reading therefore
      // costs nothing: 'already' means the caption buttons are hidden, 'renamed' that they are back.
      report.push(`${patch.label}=${renameOnce(image, patch.from, patch.to, patch.marker).status}`)
    }
    return report.join(' ')
  } catch (error) {
    return 'failed:' + (error instanceof Error ? error.message : String(error))
  } finally {
    fs.closeSync(handle)
  }
}

/* ShowWindow commands and the one message this plugin posts. */
const SW_MAXIMIZE = 3
const SW_MINIMIZE = 6
const SW_RESTORE = 9
const WM_CLOSE = 0x0010

/* An earlier pass also cleared the caption-button style bits and deleted the system menu's
 * close item. Both were measured to be the wrong tools: five minutes after clearing them the
 * platform's close button was being repainted anyway, while the edits cost the window its
 * ability to minimise (SW_MINIMIZE needs WS_MINIMIZEBOX) and its Alt+F4. The window option
 * renamed above is the real switch, so nothing here touches styles or menus. */

let binding
let bindingFailure = null

/**
 * Resolve Koffi and bind the Win32 entry points the controls need.
 * @returns the binding table, or null on a non-Windows host or a load failure.
 */
function loadBinding() {
  if (binding !== undefined) return binding
  binding = null
  if (process.platform !== 'win32') {
    bindingFailure = 'not-windows'
    return binding
  }

  const runtimeDir = typeof process.argv[2] === 'string' && process.argv[2].length > 0 ? process.argv[2] : null
  const candidates = [
    // The runtime that spawned this process passes its directory as argv[2]; its
    // node_modules holds the Koffi binding dsh already loads for Windows work.
    runtimeDir === null ? null : path.join(runtimeDir, 'node_modules', 'index.js'),
    // Beside the executable, for a launch that did not pass the runtime directory.
    path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', 'index.js'),
    // Last resort: ordinary resolution, for a composition that provides it.
    import.meta.url,
  ].filter((value) => value !== null)

  for (const from of candidates) {
    try {
      const koffi = createRequire(from)('koffi')
      const user32 = koffi.load('user32.dll')
      binding = {
        foreground: user32.func('intptr_t __stdcall GetForegroundWindow()'),
        owner: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32 *lpdwProcessId)'),
        // Win32 BOOLs come back as ints here: ShowWindow returns the window's *previous*
        // visibility, and PostMessageW whether the message was queued, so both are compared
        // against zero rather than against a bool.
        show: user32.func('int __stdcall ShowWindow(intptr_t hWnd, int nCmdShow)'),
        zoomed: user32.func('int __stdcall IsZoomed(intptr_t hWnd)'),
        iconic: user32.func('int __stdcall IsIconic(intptr_t hWnd)'),
        post: user32.func('int __stdcall PostMessageW(intptr_t hWnd, uint32 Msg, intptr_t wParam, intptr_t lParam)'),
        // Enumerating by class avoids an FFI callback: FindWindowExW walks the list.
        findClass: user32.func(
          'intptr_t __stdcall FindWindowExW(intptr_t hWndParent, intptr_t hWndChildAfter, str16 lpszClass, str16 lpszWindow)',
        ),
        visible: user32.func('int __stdcall IsWindowVisible(intptr_t hWnd)'),
        rect: user32.func('int __stdcall GetWindowRect(intptr_t hWnd, _Out_ int32 *lpRect)'),
        // The stock application menu bar. Only the menu is touched: an earlier pass also cleared
        // the caption-button style bits and deleted the close item, which cost the window its
        // minimise and Alt+F4, so SetWindowLongPtrW and DeleteMenu must not come back here.
        setMenu: user32.func('int __stdcall SetMenu(intptr_t hWnd, intptr_t hMenu)'),
        drawMenuBar: user32.func('int __stdcall DrawMenuBar(intptr_t hWnd)'),
      }
      return binding
    } catch (error) {
      bindingFailure = error instanceof Error ? error.message : String(error)
    }
  }
  return binding
}

/**
 * The harness window: the foreground window when it is ours, otherwise the largest visible
 * top-level window of the Electron shell that spawned this process.
 * @param table - the Win32 binding table.
 * @returns the window handle, or null.
 */
function harnessWindow(table) {
  const foreground = table.foreground()
  if (foreground) {
    const pid = [0]
    table.owner(foreground, pid)
    if (pid[0] === process.ppid) return foreground
  }
  let best = null
  let bestArea = 0
  let handle = table.findClass(0, 0, 'Chrome_WidgetWin_1', null)
  while (handle) {
    const pid = [0]
    table.owner(handle, pid)
    if (pid[0] === process.ppid && table.visible(handle) === true) {
      const box = [0, 0, 0, 0]
      if (table.rect(handle, box) === true) {
        const area = (box[2] - box[0]) * (box[3] - box[1])
        if (area > bestArea) {
          bestArea = area
          best = handle
        }
      }
    }
    handle = table.findClass(0, handle, 'Chrome_WidgetWin_1', null)
  }
  return best
}

function send(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(payload))
}

/**
 * Apply one window command.
 * @param action - close, minimize, zoom, or state.
 * @returns the reply payload.
 */
function run(action) {
  // The archive outcome is reported before the window is looked up: it does not depend on the
  // window at all, and the lookup is the part that fails on some machines.
  const patch = patchReport()
  const table = loadBinding()
  if (table === null) return { supported: false, reason: bindingFailure ?? 'unavailable', patch }

  const handle = harnessWindow(table)
  if (handle === null) return { supported: true, applied: false, reason: 'window-not-found', patch }

  const zoomed = () => table.zoomed(handle) !== 0
  if (action === 'state') return { supported: true, applied: false, zoomed: zoomed(), minimized: table.iconic(handle) !== 0, patch }
  if (action === 'close') return { supported: true, applied: table.post(handle, WM_CLOSE, 0, 0) !== 0 }
  if (action === 'minimize') {
    table.show(handle, SW_MINIMIZE)
    // Reported from the window's own state rather than from ShowWindow's return value, which
    // says whether the window *was* visible and is therefore always false for a hidden one.
    return { supported: true, applied: table.iconic(handle) !== 0, minimized: true }
  }
  if (action === 'zoom') {
    const maximized = zoomed()
    table.show(handle, maximized ? SW_RESTORE : SW_MAXIMIZE)
    return { supported: true, applied: zoomed() !== maximized, zoomed: zoomed() }
  }
  return { supported: false, reason: 'unknown-action' }
}

/**
 * Where the profile's manifest lives, for the watch below.
 *
 * `DSH_HOME` wins over the user profile, and the profile is `desktop` when it exists (the one the
 * desktop application creates) or the only one present.
 */
function profileManifestPath() {
  const home = process.env.DSH_HOME ?? process.env.USERPROFILE ?? process.env.HOME
  if (home === undefined) return null
  const root = process.env.DSH_HOME === undefined ? path.join(home, '.dsh', 'profiles') : path.join(home, 'profiles')
  let names
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return null
  }
  const chosen = names.includes('desktop') ? 'desktop' : names.length === 1 ? names[0] : null
  return chosen === null ? null : path.join(root, chosen, 'package.json')
}

/**
 * Is this plugin still enabled in the profile?
 *
 * Exported so the verifier can exercise it: it is the one decision that turns the archive edit off
 * again, and getting it wrong in either direction is expensive — restoring while the plugin is
 * enabled brings the caption buttons back for a whole session, and never restoring leaves them
 * hidden after the plugin was switched off.
 *
 * Anything unreadable counts as "still enabled": a parse failure must never undo the edit.
 */
export function pluginEnabledIn(manifestText, patchText, id = name) {
  try {
    const manifest = JSON.parse(manifestText)
    const bundles = manifest?.dsh?.profile?.bundles
    const listed = Array.isArray(bundles) && bundles.includes(id)
    const disabled =
      typeof patchText === 'string' &&
      new RegExp(`-\\s*id:\\s*${id}\\s*\\n\\s+disabled:\\s*true`).test(patchText)
    return listed && !disabled
  } catch {
    return true
  }
}

export function apply(ctx) {
  // Switching the plugin off in the plugin page removes its bundle row, and the client tears the
  // host half down almost at once: a two-second poll lost that race and left the archive patched,
  // which is why the caption buttons did not come back even after a restart. The same guarded check
  // therefore runs from four places — a watcher on the profile, a one-second poll as a fallback,
  // the plugin's own disposal, and the process's exit path including SIGTERM, which is how the
  // client asks the child to stop. It only ever restores when the profile says the plugin is gone,
  // so an ordinary shutdown (profile unchanged) never undoes the edit.
  ctx.effect(() => {
    const file = profileManifestPath()
    if (file === null) {
      log('watch: no profile manifest found, so disabling the plugin will not undo the archive edit')
      return
    }
    const patchFile = path.join(path.dirname(file), 'cordis.patch.yml')
    const readIfPresent = (target) => {
      try {
        return fs.readFileSync(target, 'utf8')
      } catch {
        return ''
      }
    }
    let done = false
    // Installing or uninstalling a plugin rewrites the profile and drops the bundle row for a
    // moment. Treating that instant as "the plugin was switched off" undid the archive edit while
    // the plugin was still enabled, and since the edit is only applied at load, the caption buttons
    // stayed visible for the whole session. An absence therefore has to last before it counts —
    // except on the exit path, where the profile is already in its final state and waiting is
    // pointless.
    const GRACE_MS = 2500
    let absentSince = null
    const checkAndRestore = (trigger) => {
      if (done) return
      const manifestText = readIfPresent(file)
      if (manifestText.length === 0) return
      if (pluginEnabledIn(manifestText, readIfPresent(patchFile))) {
        absentSince = null
        return
      }
      const immediate = trigger === 'exit' || trigger === 'signal'
      if (!immediate) {
        if (absentSince === null) absentSince = Date.now()
        if (Date.now() - absentSince < GRACE_MS) return
      }
      done = true
      log(`${trigger}: the plugin has been gone from the profile, so the archive edit was undone (${patchBundle('restore')})`)
    }
    const timer = setInterval(() => {
      checkAndRestore('watch')
      if (done) clearInterval(timer)
    }, 1000)
    let watcher = null
    try {
      // The directory is watched rather than the file: writers replace files, and a directory watch
      // survives that.
      watcher = fs.watch(path.dirname(file), () => checkAndRestore('watch'))
      watcher.unref?.()
    } catch {
      /* the poll covers it */
    }
    const onExit = () => checkAndRestore('exit')
    const onSignal = () => {
      checkAndRestore('signal')
      process.exit(0)
    }
    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP']
    process.on('exit', onExit)
    for (const signal of signals) process.on(signal, onSignal)
    timer.unref?.()
    return () => {
      // Disposal is the fourth trigger: it runs when the composition is reloaded.
      checkAndRestore('dispose')
      clearInterval(timer)
      if (watcher !== null) watcher.close()
      process.off('exit', onExit)
      for (const signal of signals) process.off(signal, onSignal)
    }
  })

  // A macOS window has no menu bar of its own, and the stock one sits exactly where the traffic
  // lights go, so it is cleared as soon as the plugin loads — the window already exists by then.
  // This is the one piece of the earlier Win32 pass that was worth keeping; the caption-button
  // style edits it travelled with are gone for good (verify.mjs fails if they return), because
  // they cost the window its minimise and its Alt+F4 while the platform repainted its close
  // button anyway.
  ctx.effect(() => {
    const table = loadBinding()
    if (table === null) {
      log(`menu: not cleared (${bindingFailure ?? 'unavailable'})`)
      return
    }
    const handle = harnessWindow(table)
    if (handle === null) {
      log('menu: not cleared (no visible window owned by this process\'s parent)')
      return
    }
    table.setMenu(handle, 0)
    table.drawMenuBar(handle)
    log('menu: cleared the stock application menu bar')
  })

  // The bundle edit takes effect on the next launch, because the window is created before the
  // profile composes. It comes back on unload, so disabling the plugin restores the bundle.
  // What was changed is named in the log, with the way back, so nobody has to read this file to
  // find out that the application's own archive was touched.
  ctx.effect(() => {
    const applied = patchBundle('hide')
    // 'renamed' means the edit was written just now, so this window still draws the caption buttons
    // and only the next launch is free of them; the browser half turns that into a one-line notice.
    patchOutcome = { changed: applied.includes('=renamed'), blocked: needsElevation(applied) }
    log(`bundle-patch: ${applied}`)
    if (needsElevation(applied)) {
      const asked = elevatePatch()
      log(
        asked
          ? 'bundle-patch: the application directory is not writable, so one elevation was requested; a restart applies it'
          : 'bundle-patch: the application directory is not writable; run it once as administrator to hide the caption buttons',
      )
    } else if (applied === 'bundle-not-found') {
      log('bundle-patch: app.asar was not found, so the caption buttons stay as the platform draws them')
    } else if (applied.includes('=renamed')) {
      log('bundle-patch: the caption buttons are hidden by an edit to the application archive; undo it with `node tools/bundle-patch.mjs restore`, or set DSH_MACOS_NO_BUNDLE_PATCH=1 to opt out')
    }
    return () => {
      log(`bundle-patch: ${patchBundle('restore')}`)
    }
  })

  // The route needs the web server, and asking for it with ctx.get() races the service: it
  // reads undefined whenever the server has not composed yet, and the route is then silently
  // never registered — which is exactly how the window controls stopped working once. ctx.inject
  // runs the callback when the service is actually there.
  const register = (server) => {
    if (server === undefined || typeof server.register !== 'function') {
      log('route: no web server, so the window controls cannot be driven')
      return
    }
    server.register({
      kind: 'exact',
      path: WINDOW_ROUTE,
      handler: (request, response) => {
        if (request.method !== 'POST') {
          send(response, 405, { supported: false, reason: 'method-not-allowed' })
          return
        }
        const chunks = []
        let size = 0
        request.on('data', (chunk) => {
          size += chunk.length
          // A window command is a few dozen bytes; anything larger is not one.
          if (size > 1024) {
            request.destroy()
            return
          }
          chunks.push(chunk)
        })
        request.on('end', () => {
          let action = 'state'
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            if (parsed !== null && typeof parsed.action === 'string') action = parsed.action
          } catch {
            send(response, 400, { supported: false, reason: 'invalid-body' })
            return
          }
          try {
            const result = run(action)
            // The browser half runs in the renderer, so this log is the only way to see from
            // outside whether its requests actually arrive.
            log(`action=${action} result=${JSON.stringify(result)}`)
            send(response, 200, result)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            log(`action=${action} threw=${message}`)
            send(response, 200, { supported: false, reason: message })
          }
        })
        request.on('error', () => {
          response.destroy()
        })
      },
    })
    log(`route: registered ${WINDOW_ROUTE}`)
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => register(scope.webServer ?? scope.get('webServer')))
  } else {
    register(ctx.get('webServer'))
  }
}


