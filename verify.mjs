/**
 * verify.mjs — the gate for dsh-macos.
 *
 * No arguments, no dependencies, no dsh installation, no browser. It checks the step the
 * plugin currently implements, so a regression fails here rather than in the window:
 *
 *   1. Host half    — exports the bundle name and an apply seam, and imports nothing it
 *                     cannot reach from the Node-mode child process it runs in.
 *   2. Manifest     — bundle patch, web client, ./client export, and the display
 *                     metadata the Plugins page reads.
 *   3. Client half  — loads in a stubbed browser, injects exactly one stylesheet,
 *                     mounts nothing yet, imports only react, and disposes its sheet.
 *   4. The window   — the three promises of this step: the stock menu is hidden, the
 *                     window is split at the published sidebar width, and the whole left
 *                     column is frosted in both appearances.
 *   5. Hazards      — the two ways this kind of styling breaks the client: a filter on
 *                     an element that contains fixed-position chrome (which re-parents
 *                     it), and host class names that this build does not ship.
 *
 * Usage:
 *   node verify.mjs [--surface <file>]
 */
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const fail = []
const note = (message) => console.log(message)

const argv = process.argv.slice(2)
const surfaceArgIndex = argv.indexOf('--surface')
const surfaceDir = path.join(root, 'surface')
const surfaceFile =
  surfaceArgIndex >= 0
    ? argv[surfaceArgIndex + 1]
    : fs.existsSync(surfaceDir)
      ? path.join(surfaceDir, fs.readdirSync(surfaceDir).filter((name) => name.endsWith('.json')).sort().pop() ?? '')
      : undefined
if (!surfaceFile || !fs.existsSync(surfaceFile)) fail.push('no surface snapshot found in surface/')

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

// ---------------------------------------------------------------- 1. host half
const hostSource = fs.readFileSync(path.join(root, 'lib/index.js'), 'utf8')
const host = await import(pathToFileURL(path.join(root, 'lib/index.js')).href)
if (host.name !== pkg.name) fail.push(`lib/index.js exports name ${JSON.stringify(host.name)}, expected ${JSON.stringify(pkg.name)}`)
if (typeof host.apply !== 'function') fail.push('lib/index.js does not export an apply() seam')
if (/from\s+['"]electron['"]|require\(\s*['"]electron['"]\s*\)/.test(hostSource)) {
  fail.push('the host half imports electron, which cannot work in the Node-mode child process it runs in')
}
if (typeof host.WINDOW_ROUTE !== 'string' || !host.WINDOW_ROUTE.startsWith('/')) {
  fail.push('the host half exports no WINDOW_ROUTE for the browser half to post to')
}
// The window lives in the Electron main process, which this process cannot import; the
// controls must go through Win32 and must verify window ownership first.
for (const needle of ['GetForegroundWindow', 'ShowWindow', 'PostMessageW', 'IsZoomed', 'process.ppid']) {
  if (!hostSource.includes(needle)) fail.push(`the host half does not use ${needle}`)
}
if (!/request\.method !== 'POST'/.test(hostSource)) fail.push('the window route does not reject non-POST requests')
if (!/size > 1024/.test(hostSource)) fail.push('the window route does not cap the request body')
// The style and menu edits were measured to be the wrong tools: the platform repainted its
// close button anyway, while the edits cost the window SW_MINIMIZE and Alt+F4. They must not
// come back; the window option renamed below is the real switch. Comments are excluded from
// the check, because the code explains what it deliberately does not do.
const hostCode = hostSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
for (const forbidden of ['SetWindowLongPtrW', 'DeleteMenu', 'SC_CLOSE', 'WS_MINIMIZEBOX']) {
  if (hostCode.includes(forbidden)) {
    fail.push(`the host half edits window styles or menus again (${forbidden}), which broke minimise and Alt+F4`)
  }
}
if (!/ctx\.inject\(\['webServer'\]/.test(hostSource)) {
  fail.push('the route is registered without waiting for the web server, so it would silently vanish whenever that service composes late')
}

// The route handler is executed here, not merely described. A helper missing from it once threw
// ReferenceError inside the handler and took the whole application down at startup, and reading
// the source could never catch that — only running it can. The bundle edit is switched off for
// the test so nothing touches the installed application.
{
  const captured = {}
  process.env.DSH_MACOS_NO_BUNDLE_PATCH = '1'
  try {
    host.apply({
      effect: (effect) => {
        effect()
      },
      inject: (deps, callback) => {
        callback({
          webServer: {
            register: (options) => {
              captured.handler = options.handler
            },
          },
        })
      },
      get: () => undefined,
    })
  } catch (error) {
    fail.push('apply() threw against a plain context: ' + (error instanceof Error ? error.message : String(error)))
  } finally {
    delete process.env.DSH_MACOS_NO_BUNDLE_PATCH
  }

  if (captured.handler === undefined) {
    fail.push('apply() registered no route handler, so the window controls could never be driven')
  } else {
    const invoke = (method, body) => {
      const response = {
        status: 0,
        body: '',
        writeHead(status) {
          this.status = status
        },
        end(text) {
          this.body = text
        },
        destroy() {},
      }
      const request = {
        method,
        on(event, handler) {
          if (event === 'data' && body !== undefined) handler(Buffer.from(body))
          if (event === 'end') handler()
          return this
        },
        destroy() {},
      }
      captured.handler(request, response)
      return response
    }

    const denied = invoke('GET')
    const answered = invoke('POST', JSON.stringify({ action: 'state' }))
    let parsed = null
    try {
      parsed = JSON.parse(answered.body)
    } catch {
      /* reported below */
    }
    if (denied.status !== 405) fail.push(`a non-POST request answered ${denied.status}, expected 405`)
    else if (answered.status !== 200) fail.push(`a POST answered ${answered.status}, expected 200`)
    else if (parsed === null || typeof parsed.supported !== 'boolean') {
      fail.push('the route answered without a supported flag')
    } else {
      note('route handler        : executed — 405 to a GET, JSON with a supported flag to a POST')
    }
  }
}

// Removing the platform's caption buttons for good means renaming the window option that
// enables the overlay — and, because the main process throws "Titlebar overlay is not
// enabled" when that option is gone and the preload still reports its colours, renaming the
// reporting channel in the same pass. Renaming the option alone is what crashed startup once.
if (typeof host.renameOnce !== 'function' || typeof host.patchBundle !== 'function') {
  fail.push('the host half does not export the bundle renamer the caption buttons depend on')
} else {
  if (!/OPTION_MARKER/.test(hostSource) || !/chromeFallbackFill/.test(hostSource)) {
    fail.push('the option rename is not marker-guarded, so the welcome window would lose its own controls')
  }
  if (!/CHANNEL_FROM/.test(hostSource) || !/preload-app\.cjs/.test(hostSource)) {
    fail.push('the appearance channel is not renamed, so the main process would throw once the option is gone')
  }
  if (!/patchBundle\('restore'\)/.test(hostSource)) fail.push('the bundle edits are not reverted on unload')
  if (!/DSH_MACOS_NO_BUNDLE_PATCH/.test(hostSource)) fail.push('the bundle edits cannot be switched off by environment')

  // The renamer, exercised on a synthetic bundle image: only the marked occurrence is
  // touched, a second pass is a no-op, and the round trip restores the image exactly.
  const image = Buffer.from(
    'const main = new BrowserWindow({ titleBarStyle: "hidden", titleBarOverlay: { height: 40, color: chromeFallbackFill() } });' +
      'const welcome = { titleBarStyle: "hidden", titleBarOverlay: { color: "#00000000", symbolColor: "#0F1115", height: 42 } };' +
      'electron.ipcRenderer.send("dsh-desktop:windows-appearance", lang, color, symbol);',
    'latin1',
  )
  const original = Buffer.from(image)
  const first = host.renameOnce(image, 'titleBarOverlay', 'titleBarOverlaX', 'chromeFallbackFill')
  const channel = host.renameOnce(image, 'dsh-desktop:windows-appearance', 'dsh-desktop:windows-appearancX')
  const text = image.toString('latin1')
  if (first.status !== 'renamed' || !text.includes('titleBarOverlaX: { height: 40')) {
    fail.push('the renamer did not rename the main window option')
  } else if (!text.includes('titleBarOverlay: { color: "#00000000"')) {
    fail.push('the renamer also renamed the welcome window option, which needs its own controls')
  } else if (channel.status !== 'renamed' || !text.includes('"dsh-desktop:windows-appearancX"')) {
    fail.push('the renamer did not rename the appearance channel')
  } else if (host.renameOnce(image, 'titleBarOverlay', 'titleBarOverlaX', 'chromeFallbackFill').status !== 'already') {
    fail.push('the renamer is not idempotent')
  } else if (host.renameOnce(image, 'titleBarOverlaX', 'titleBarOverlay', 'chromeFallbackFill').status !== 'renamed') {
    fail.push('the renamer cannot be reverted')
  } else if (host.renameOnce(image, 'dsh-desktop:windows-appearancX', 'dsh-desktop:windows-appearance').status !== 'renamed') {
    fail.push('the channel rename cannot be reverted')
  } else if (!image.equals(original)) {
    fail.push('the rename round trip did not restore the bundle image')
  } else if (host.renameOnce(Buffer.from('titleBarOverlay'), 'titleBarOverlay', 'shorter').status !== 'length-mismatch') {
    fail.push('the renamer does not reject a replacement of a different length, which would break the archive offsets')
  } else {
    note('bundle edits         : same-length renames of the window option (marker-guarded) and the appearance channel, idempotent and reversible')
  }
}
if (Array.isArray(host.inject) && host.inject.indexOf('webServer') !== -1) {
  fail.push('the host half hard-injects webServer, so a composition without an HTTP server would lose the whole skin')
}
note(`host half            : Win32 window commands behind a POST-only ${host.WINDOW_ROUTE}, guarded by process.ppid`)

// ---------------------------------------------------------------- 2. manifest
if (!pkg.dsh?.bundle?.patch) fail.push('package.json is missing dsh.bundle.patch')
if (pkg.dsh?.client?.platform !== 'web') fail.push('package.json is missing dsh.client.platform = "web"')
if (!pkg.exports?.['./client']) fail.push('package.json is missing the ./client export')
if (typeof pkg.meta?.title !== 'string' || pkg.meta.title.length === 0) fail.push('package.json meta.title is empty')
for (const rel of [pkg.dsh?.bundle?.patch, 'lib/index.js', 'lib/client.js', 'icon.svg', 'locale/en.json', 'locale/zh.json']) {
  if (rel && !fs.existsSync(path.join(root, rel))) fail.push(`declared file missing: ${rel}`)
}
const patch = fs.readFileSync(path.join(root, pkg.dsh.bundle.patch), 'utf8')
if (!new RegExp(`id:\\s*${pkg.name}`).test(patch)) fail.push(`bundle patch does not insert the ${pkg.name} row`)
for (const [language, file] of [['en', 'locale/en.json'], ['zh', 'locale/zh.json']]) {
  try {
    const document = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
    if (typeof document.title !== 'string' || document.title.length === 0) fail.push(`${file} has no title`)
    if (typeof document.description !== 'string' || document.description.length === 0) fail.push(`${file} has no description`)
  } catch (error) {
    fail.push(`${language} locale is not valid JSON: ${error.message}`)
  }
}
note(`manifest             : bundle row "${pkg.name}", web client, icon and locale en + zh`)

// -------------------------------------------------------------- 3. client half
const source = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8')
if (source.includes('shadowRoot')) fail.push('the client reaches into a shadow root; the stock menu may only be hidden')
const requires = [...new Set([...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]))]
const foreign = requires.filter((name) => name !== 'react')
if (foreign.length > 0) fail.push(`imports packages other than "react": ${foreign.join(', ')}`)

const surface = JSON.parse(fs.readFileSync(surfaceFile, 'utf8'))
const elementStore = []
const cleanups = []
const requests = []
const calls = { injectedSlots: [], registered: [] }
const ctx = {
  // Every effect this plugin registers returns a disposer, and unloading runs them; the
  // harness keeps them so the disposal path can be exercised for real.
  effect: (effect) => {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  },
  on: () => () => {},
  slots: {
    inject: (name, callback) => {
      calls.injectedSlots.push(name)
      callback()
      return () => {}
    },
    register: (options, Component) => {
      calls.registered.push({ options, Component })
      return () => {}
    },
    entries: () => [],
    subscribe: () => () => {},
  },
}
const sandbox = {
  console,
  Symbol,
  // The controls race every command against a timeout, so the stub needs timers.
  setTimeout: () => 0,
  clearTimeout: () => {},
  document: {
    // The preload writes data-platform on <html>; this plugin is expected to override it and
    // to put it back on unload, so the stub keeps a real dataset object to observe.
    // hasAttribute reports the desktop shell's frame attribute, which the client half requires
    // before it does anything: without it, a plain browser would get the macOS platform too.
    documentElement: { dataset: { platform: 'win32' }, hasAttribute: (name) => name === 'data-windows-titlebar' },
    head: { appendChild: (element) => elementStore.push(element) },
    createElement: () => ({
      attributes: {},
      textContent: '',
      setAttribute(name, value) {
        this.attributes[name] = value
      },
      remove() {
        const index = elementStore.indexOf(this)
        if (index >= 0) elementStore.splice(index, 1)
      },
    }),
  },
  // The window controls post to the host route; every request is recorded so the wiring can
  // be asserted rather than assumed.
  fetch: (url, options) => {
    requests.push({ url, body: options && options.body ? JSON.parse(options.body) : null })
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ supported: true, applied: true, zoomed: false }) })
  },
  window: { __ModuleLoader__: { load: (definition) => { sandbox.__definition = definition } } },
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

const definition = sandbox.__definition
let injectedCss = ''
if (!definition) {
  fail.push('lib/client.js did not call window.__ModuleLoader__.load')
} else {
  if (definition.id !== pkg.name) fail.push(`bundle id ${JSON.stringify(definition.id)} != package name ${JSON.stringify(pkg.name)}`)
  else note(`bundle id            : ${definition.id} (matches the package name)`)

  const module_ = definition.factory((name) => {
    if (name !== 'react') throw new Error('unexpected require("' + name + '")')
    return {
      createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
      Fragment: Symbol('react.fragment'),
      // Enough of the hook surface for the controls: state that holds its initial value, an
      // effect that runs, and a ref. The handlers can then be invoked directly.
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: (effect) => {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      },
      useRef: () => ({ current: null }),
    }
  })
  if (typeof module_.apply !== 'function') fail.push('client bundle does not export apply()')
  const injectedServices = Array.isArray(module_.inject) ? module_.inject : []
  const unknownServices = injectedServices.filter((name) => !surface.services.includes(name))
  if (unknownServices.length > 0) fail.push(`injects service(s) this build does not provide: ${unknownServices.join(', ')}`)

  module_.apply(ctx)
  if (calls.registered.length !== 1) fail.push(`registered ${calls.registered.length} slot entries, expected exactly 1 (the window controls)`)
  for (const entry of calls.registered) {
    const name = entry.options.name
    if (calls.injectedSlots.indexOf(name) === -1) fail.push(`registered into ${name} without injecting that slot`)
    if (surface.slots.indexOf(name) === -1) fail.push(`slot "${name}" is absent from this build's slot catalog`)
  }
  if (calls.registered.length === 1 && surface.slots.indexOf(calls.registered[0].options.name) !== -1) {
    note(`slot contract        : the window controls mount into "${calls.registered[0].options.name}", a slot this build composes`)
  }
  // A second live instance would mean a second stylesheet and a second set of dots, so a
  // re-apply must undo the previous one first.
  if (!/__dshMacos/.test(source) || !/previous\.dispose\(\)/.test(source)) {
    fail.push('the client does not dispose a previous instance on re-apply, so a reload would double the chrome')
  }
  if (elementStore.length !== 1) fail.push(`injected ${elementStore.length} stylesheets, expected exactly 1`)
  else {
    injectedCss = elementStore[0].textContent || ''
    note(`chrome injection     : one <style> element, ${injectedCss.length} bytes`)
    for (const cleanup of elementStore.slice()) {
      /* the sheet is removed by its effect's disposer, exercised below */
    }
  }
  // Inheriting dsh's own macOS styling is the point of this step, and the platform attribute
  // is the only switch for it.
  const platform = sandbox.document.documentElement.dataset.platform
  if (platform !== 'darwin') {
    fail.push(`the platform attribute is ${JSON.stringify(platform)}, so dsh's own macOS styling stays off`)
  } else {
    note('platform             : reported as darwin, so dsh\'s shipped macOS rules apply (frame, sidebar fill, divider, button, brand)')
  }
}

// ------------------------------------------------------------- 4. the window
// Comments are stripped first: prose such as "window. filter, transform" would
// otherwise be read as a class selector once the text is flattened.
const cssOnly = injectedCss.replace(/\/\*[\s\S]*?\*\//g, '')
const flat = cssOnly.replace(/\s+/g, '')
const frameBlock = /:has\(>\[data-shell-overlay\]\)\{([^}]*)\}/.exec(flat)
const frostBlock = /:has\(>\[data-shell-overlay\]\):before\{([^}]*)\}/.exec(flat)

if (injectedCss !== '') {
  // 1. the stock window menu is gone.
  if (!/\[data-windows-menu\]\{display:none!important\}/.test(flat)) {
    fail.push('the stock window menu is not hidden, so 应用/编辑 are still there')
  } else {
    note('stock menu           : hidden, so the preload\'s 应用/编辑 titles are gone')
  }

  // 1b. the 40px band itself is gone, not merely hidden: the variable drives the frame's
  // padding-top as well as the strip pseudo-element, so zeroing it moves everything up.
  const rootBlock = /html\[data-windows-titlebar\]\{([^}]*)\}/.exec(flat)
  if (rootBlock === null || !/--dsh-windows-titlebar-height:0px!important/.test(rootBlock[1])) {
    fail.push('the reserved title strip is not collapsed, so the sidebar and content are still pushed 40px down')
  } else {
    note('no title strip       : --dsh-windows-titlebar-height:0px !important, so the frame\'s padding-top and the strip both collapse')
  }
  const afterBlock = /:has\(>\[data-shell-overlay\]\):after\{([^}]*)\}/.exec(flat)
  if (afterBlock === null || !/-webkit-app-region:drag/.test(afterBlock[1])) {
    fail.push('the window lost its drag region with the strip and nothing replaced it')
  } else if (!/left:88px/.test(afterBlock[1])) {
    fail.push('the drag region starts under the window controls, and its clicks would be swallowed')
  } else if (!/width:max\(0px,calc\(var\(--dsh-windows-sidebar-width,280px\)-180px\)\)/.test(afterBlock[1])) {
    fail.push('the drag region is not inset from the sidebar toggle, so the toggle could become unclickable')
  } else {
    note('drag region          : an inset grab band over the sidebar\'s header, clear of the controls and the toggle')
  }

  // 2. the pane keeps only its shape; the fills belong to dsh's darwin rules now.
  if (frameBlock === null) fail.push('the window frame has no rule of its own')
  else {
    const body = frameBlock[1]
    if (!/border-radius:18px/.test(body)) fail.push('the pane is not rounded, so it cannot read as a macOS window')
    if (!/isolation:isolate/.test(body)) fail.push('the frame is not isolated, so the blur layer\'s paint order is not guaranteed')
    if (/(?:^|;)(?:-webkit-)?(?:filter|transform|contain|perspective):/.test(body)) {
      fail.push('the frame sets filter/transform/contain, which would re-parent the fixed-position window chrome')
    }
    if (/(?:^|;)background:/.test(body)) {
      fail.push('the frame paints a fill of its own, which would fight the fill dsh\'s darwin rules give it')
    }
    if (/\._2H3hWW_root\{[^}]*background/.test(flat)) {
      fail.push('the plugin overrides the sidebar\'s own background, which dsh\'s darwin rules make transparent')
    }
    // The one fill this sheet touches, and only as a platform substitution: on macOS that
    // fill is 90% opaque over the window server's vibrancy, and Windows has no vibrancy, so
    // an unthinned fill over this plugin's blur layer would simply be opaque.
    if (!/\.BynINW_sidebarCol\{background:color-mix\(insrgb,var\(--dsw-specific-sidebar-fill\)\d+%,transparent\)!important\}/.test(flat)) {
      fail.push('the sidebar fill is not thinned, so no backdrop reaches the glass on Windows')
    } else {
      const mix = /--dsw-specific-sidebar-fill\)(\d+)%,transparent/.exec(flat)
      const share = Number(mix[1]) / 100
      if (share > 0.9 || share < 0.4) fail.push(`the sidebar fill is ${share} opaque, outside the 40-90% band that keeps text readable over a blurred backdrop`)
      else note(`sidebar fill         : thinned to ${mix[1]}% over the blur layer, standing in for the window server's vibrancy`)
    }
    note('pane                 : shape only (rounded, isolated, no fill) — the frame and divider come from dsh\'s darwin rules')
  }

  // 3. the whole left column is frosted, in both appearances.
  if (frostBlock === null) fail.push('there is no frosted layer over the window')
  else {
    const body = frostBlock[1]
    if (!/backdrop-filter:blur\(/.test(body)) fail.push('the frosted layer does not blur its backdrop')
    if (!/saturate\(180%\)/.test(body)) fail.push('the frosted layer does not saturate, so it will look flat rather than vibrant')
    if (!/z-index:-1/.test(body)) fail.push('the frosted layer is not behind the rows, so it would blur the sidebar\'s own text')
    // It shares its pseudo-element with dsh's strip, whose `height` would otherwise win and
    // confine the frost to the top band. That is the bug this check exists for.
    if (!/height:auto/.test(body)) fail.push('the frosted layer does not override the strip\'s height, so it would cover only the top band')
    if (!/-webkit-app-region:no-drag/.test(body)) fail.push('the frosted layer would swallow input, since that pseudo-element is a drag region by default')
    // The glass cue: a highlight along the top edge, defined per appearance.
    if (!/box-shadow:inset01px0var\(--dsh-macos-glass-edge\)/.test(body)) {
      fail.push('the frosted layer has no top highlight, so it reads as a flat tint rather than glass')
    }
    // Frosted glass reads from its texture: a fine grain, and a light inner edge where the
    // surface ends. The layer carries no tint of its own — the colour is dsh's darwin fill.
    if (!/feTurbulence/.test(body)) fail.push('the frosted layer has no grain, so it reads as a flat tint')
    if (!/feColorMatrix/.test(body)) fail.push('the grain is not desaturated, so it would add colour speckle')
    if (/linear-gradient|--dsh-macos-sidebar\)/.test(body)) {
      fail.push('the blur layer carries a tint, which would double up on the sidebar fill dsh already paints')
    }
    if (!/\._2H3hWW_root\{[^}]*box-shadow:inset-1px00var\(--dsh-macos-glass-inner\)/.test(flat)) {
      fail.push('the sidebar has no inner edge highlight, so the glass has no boundary')
    }
    if ((flat.match(/--dsh-macos-glass-edge:rgba\(/g) || []).length < 2) {
      fail.push('the glass highlight is defined for only one appearance')
    }
    note('blur + grain         : full-frame blur(28px) saturate(180%) with grain and edge highlights, behind the rows')
  }
  // dsh's own 160px clearance is load-bearing: shrinking it to the width the dots occupy was
  // measured to push the seat's controls onto the session title.
  if (/--dsh-frame-leading-clearance/.test(flat)) {
    fail.push('the plugin overrides the frame clearance, which controls where the seat lands and what it overlaps')
  } else {
    note('seat clearance       : left to dsh, whose 160px keeps the toggle and the new-session button clear of the title')
  }
  // The two controls dsh parks in the band are pinned to one place for both sidebar states. A
  // state-dependent position is what produced two copies at slightly different spots while the
  // sidebar animated, so the placement must not mention the collapsed attribute at all.
  // macOS rounds a window further than dsh does on Windows. The pane's radius and the blur layer's
  // must match, or the frost would show a light rim inside the corners.
  const radii = [...flat.matchAll(/border-radius:(\d+)px/g)].map((m) => Number(m[1]))
  if (!radii.includes(18)) fail.push('the window corners are not rounded to the macOS radius (18px)')
  else if (radii.filter((value) => value === 18).length < 2) {
    fail.push('the pane and its blur layer do not share one corner radius, so the frost would rim the corners')
  } else if (!/_2H3hWW_root:not\(\._2H3hWW_collapsed\)\._2H3hWW_newSession\{border-radius:12px\}/.test(flat)) {
    fail.push('the expanded new-session button keeps dsh\'s tighter radius')
  } else {
    note('corner radii         : 18px on the pane and its blur layer; the expanded new-session button at 12px')
  }
  // The seam between the two parts: dsh rounds the content column's top-left corner, which cuts a
  // curve into it. It must be squared, while the pane keeps its own rounding for the window's
  // outer corners.
  if (!/_2H3hWW_root\[data-windows-titlebar\] \.BynINW_centerCol\{border-top-left-radius:0!important\}|\.BynINW_centerCol\{border-top-left-radius:0!important\}/.test(flat)) {
    fail.push('the content column keeps its rounded top-left corner, so the seam between the two parts is not flush')
  } else {
    note('the seam             : the content column\'s top-left corner is squared, so the two parts join flush')
  }
  // The two families appear in different states: collapsed, dsh's own band controls are the ones
  // to keep; expanded, they are absent and the sidebar's own two are the only ones there are.
  // Hiding both outright is what made them disappear entirely once the sidebar was expanded.
  const hidesCollapsedCopies = /_2H3hWW_collapsed\._2H3hWW_toggle,\s*html\[data-windows-titlebar\]\._2H3hWW_collapsed\._2H3hWW_newSession\{display:none!important\}/.test(flat)
  const hidesUnconditionally = /^\s*html\[data-windows-titlebar\]\._2H3hWW_toggle,\s*html\[data-windows-titlebar\]\._2H3hWW_newSession\{display:none/m.test(flat)
  const placesExpandedToggle = /_2H3hWW_root:not\(\._2H3hWW_collapsed\)\._2H3hWW_toggle\{top:8px;left:calc\(var\(--dsh-windows-sidebar-width,280px\)-40px\)\}/.test(flat)
  if (hidesUnconditionally) fail.push('both control families are hidden in every state, so the expanded sidebar loses its toggle and its new-session button')
  else if (!hidesCollapsedCopies) fail.push('the duplicated copies are not hidden while the sidebar is collapsed, so each control appears twice in that row')
  else if (!placesExpandedToggle) fail.push('the expanded sidebar toggle has no top edge, so it would sit above the window')
  else {
    note('strip controls       : collapsed keeps dsh\'s own band pair and drops the duplicates; expanded keeps the sidebar\'s pair')
  }  // The window controls sit exactly where macOS puts them, in the clearance dsh's darwin
  // layout reserves, and opt out of the drag band so they stay clickable.
  const dotSize = /\.dsh-macos-trafficbutton\{width:(\d+)px;height:\1px/.exec(flat)
  const gap = /\.dsh-macos-traffic\{[^}]*gap:(\d+)px/.exec(flat)
  if (!/\.dsh-macos-traffic\{position:fixed;top:16px;left:16px/.test(flat)) {
    fail.push('the window controls are not inset at the macOS position (16 from the left, centred on a 24px row)')
  } else if (!/\.dsh-macos-traffic\{[^}]*app-region:no-drag/.test(flat)) {
    fail.push('the window controls do not opt out of the drag band, so they could not be clicked')
  } else if (dotSize === null || gap === null) {
    fail.push('the window controls have no explicit dot size or gap')
  } else {
    const span = 16 + 3 * Number(dotSize[1]) + 2 * Number(gap[1])
    if (span > 84) {
      fail.push(`the controls span ${span}px, past the 84px dsh reserves for a compact set, so the controls after them would shift`)
    } else {
      note(`controls geometry    : ${dotSize[1]}px dots, ${gap[1]}px apart, spanning ${span}px of the 84px reserved`)
    }
  }
  // No competing fill of our own: the sidebar's material is dsh's, and a second one here
  // would silently override it.
  for (const forbidden of ['--dsh-macos-sidebar-tint', '--dsh-macos-sidebar-alpha', '--dsh-macos-sidebar:', '--dsh-macos-divider']) {
    if (flat.includes(forbidden)) fail.push(`the plugin declares ${forbidden}, which competes with the fill dsh's darwin rules provide`)
  }
  // The backdrop must stay flat and achromatic. A gradient or a coloured blob behind the
  // window shows straight through the glass as a colour cast and a top-to-bottom ramp,
  // because the window's left column is transparent by design.
  const lightDesktop = /html,body\{background:(#[0-9a-f]{3,8})!important\}/i.exec(flat)
  const darkDesktop = /html:has\(body\[data-ds-dark-theme\]\),html:has\(body\[data-ds-dark-theme\]\)body\{background:(#[0-9a-f]{3,8})!important\}/i.exec(flat)
  if (lightDesktop === null || darkDesktop === null) {
    fail.push('the backdrop is not a flat colour in both appearances, so the glass would pick up a cast or a gradient')
  } else {
    note(`backdrop             : flat and neutral (${lightDesktop[1]} light, ${darkDesktop[1]} dark), so the glass carries no colour of its own`)
  }
  // The sidebar's own transparency is dsh's (its darwin rule sets `background:0 0`), which the
  // platform check above covers; what matters here is that this sheet does not fight it.

  // ------------------------------------------------------------- 5. hazards
  // A filter on the frame itself, or on any sidebar element, makes that element a
  // containing block for the fixed-position chrome inside it (the sidebar holds a fixed
  // toggle, and ui-layout's overlay holds the window controls).
  if (frameBlock !== null && /(?:^|;)(?:-webkit-)?(?:filter|transform|contain|perspective):/.test(frameBlock[1])) {
    fail.push('the frame sets filter/transform/contain, which would re-parent the fixed-position window chrome')
  }
  if (frameBlock !== null && !/isolation:isolate/.test(frameBlock[1])) {
    fail.push('the frame is not isolated, so the frosted layer\'s paint order is not guaranteed')
  }
  for (const rule of injectedCss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!rule[1].includes('_2H3hWW_')) continue
    if (/(?:^|;)(?:-webkit-)?(?:backdrop-)?filter:/.test(rule[2].replace(/\s+/g, ''))) {
      fail.push('a filter is applied to a sidebar element, which would re-parent its fixed-position toggle')
    }
  }
  const referenced = new Set()
  for (const rule of flat.matchAll(/([^{}]+)\{/g)) {
    if (rule[1].includes('dsh-macos-')) continue
    for (const name of rule[1].matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) referenced.add(name[1])
  }
  const known = new Set(Object.values(surface.classes || {}).flat())
  const unknown = [...referenced].filter((name) => !known.has(name))
  if (unknown.length > 0) fail.push(`references host class(es) this build does not ship: ${unknown.join(', ')}`)
  else note(`host classes         : ${[...referenced].length} referenced, all present in the ${surface.dshVersion} snapshot (${known.size} names)`)
}

// ------------------------------------------------------------- 6. behaviour
// The three dots are rendered and then clicked: the yellow one must reach the host route with
// a real command, which is the whole point of the host half.
if (injectedCss !== '' && calls.registered.length === 1) {
  const rendered = calls.registered[0].Component({})
  const nodes = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return null
    if (Array.isArray(node)) return node.map(walk)
    if (typeof node.type === 'function') return walk(node.type(node.props || {}))
    nodes.push(node)
    return { type: node.type, props: node.props, children: (node.children || []).map(walk).filter((child) => child !== null) }
  }
  walk(rendered)
  const dots = nodes.filter((node) => node.props && typeof node.props.className === 'string' && /^dsh-macos-tl-/.test(node.props.className))
  if (dots.length !== 3) fail.push(`the window controls render ${dots.length} dots, expected 3`)
  else note('render               : three window controls drawn in the overlay')
  const minimize = nodes.find((node) => node.props && node.props.className === 'dsh-macos-tl-min')
  if (minimize === undefined || typeof minimize.props.onClick !== 'function') {
    fail.push('the minimise control is not a wired button')
  } else {
    const before = requests.length
    minimize.props.onClick()
    const request = requests[requests.length - 1]
    if (requests.length === before || request === undefined || request.body === null || request.body.action !== 'minimize') {
      fail.push('the minimise control does not post an action to the host route')
    } else if (request.url !== host.WINDOW_ROUTE) {
      fail.push(`the window controls post to ${JSON.stringify(request.url)}, expected the exported WINDOW_ROUTE`)
    } else {
      note(`wiring               : a control reaches ${host.WINDOW_ROUTE} with a real action`)
    }
  }
  if (!requests.some((request) => request.body !== null && request.body.action === 'state')) {
    fail.push('the controls never ask the host whether it can drive the window')
  } else {
    note('capability probe     : the controls ask the host for window state before relying on it')
  }
}

// Every rename must carry a marker. Without one, a same-named string belonging to something else
// could be renamed instead — and, just as bad, a coincidence could be reported as "already
// applied", which would leave the caption buttons in place while the log claimed success.
{
  const markerCheck = /const PATCHES = \[([\s\S]*?)\]/.exec(hostSource)
  const body = markerCheck === null ? '' : markerCheck[1]
  const entries = [...body.matchAll(/marker:\s*([A-Za-z_$][\w$]*|null)/g)].map((match) => match[1])
  if (entries.length < 2) fail.push('the patch table does not declare a marker per rename')
  else if (entries.some((entry) => entry === 'null')) {
    fail.push('a rename is applied without a context marker, so it could hit an unrelated occurrence')
  } else {
    note('bundle edits         : both renames are marker-guarded, in both directions')
  }
}
// ------------------------------------------------------------- bundle discovery
// The host child is spawned as
//   node --expose-internals <…>/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js <runtimeDir> <projectDir>
// so neither argv[2] (the host entry) nor process.execPath (the node binary) names the archive.
// Reading the wrong one made the plugin report "bundle-not-found" and silently stop re-applying
// the caption-button edit after an application update.
if (typeof host.asarFromArgv !== 'function') {
  fail.push('the host half does not expose the argument parse that locates app.asar')
} else {
  const entry = 'D:/apps/Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'
  const runtime = 'D:/apps/Harness/resources/app.asar/dsh'
  const found = host.asarFromArgv(['--expose-internals', entry, runtime, 'D:/projects/work'])
  const archive = 'D:\\apps\\Harness\\resources\\app.asar'
  if (found.length === 0 || found[0] !== archive) {
    fail.push(`the host resolves the archive as ${JSON.stringify(found[0])}, expected ${JSON.stringify(archive)}`)
  } else if (host.asarFromArgv(['script.js']).some((candidate) => candidate.toLowerCase().includes('asar'))) {
    fail.push('the argument parse invents an archive when none was named')
  } else {
    note('bundle discovery     : the archive is read from the host entry path, not from argv[2] or execPath')
  }
}
// ------------------------------------------------------------- desktop only
// The bundle is declared with the web platform, so this half also loads in a plain browser, where
// there is no Windows frame and no host window. The desktop marker must gate everything: without
// it the browser client would report itself as darwin and lose its own chrome.
if (!/typeof window\.dshDesktop !== 'undefined'/.test(source) || !/if \(!desktop\) return/.test(source)) {
  fail.push('the client half applies outside the desktop shell, where it would flip the platform attribute in a browser')
} else {
  note('desktop only         : the client half returns early unless the desktop shell is present')
}

// ------------------------------------------------------------- re-apply
// A second apply is exercised for real. The previous instance's disposer restores the platform
// attribute, so if it ran after the new instance installed, the platform would silently revert to
// win32 and every darwin rule — including the layout that keeps the title clear of the controls —
// would switch off. That is not hypothetical: it is what reverted the layout once.
if (injectedCss !== '') {
  const second = definition.factory((name) => {
    if (name !== 'react') throw new Error('unexpected require("' + name + '")')
    return {
      createElement: () => null,
      Fragment: Symbol('react.fragment'),
      useState: (initial) => [initial, () => {}],
      useEffect: () => {},
      useRef: () => ({ current: null }),
    }
  })
  sandbox.document.documentElement.dataset.platform = 'darwin'
  try {
    second.apply(ctx)
  } catch (error) {
    fail.push('a second apply threw: ' + (error instanceof Error ? error.message : String(error)))
  }
  const after = sandbox.document.documentElement.dataset.platform
  if (after !== 'darwin') {
    fail.push(`a second apply left the platform at ${JSON.stringify(after)}; the old instance's restore ran after the new one`)
  } else {
    note('idempotent apply     : a second apply keeps darwin reported, so a reload cannot revert the layout')
  }
}

// ------------------------------------------------------------- disposal
// apply() registers two effects; unloading must undo both, so the harness runs the
// disposers they returned and requires the document to be left as it was found.
if (injectedCss !== '') {
  if (cleanups.length < 3) fail.push(`apply() registered only ${cleanups.length} effects; the platform, the sheet and the controls are each one`)
  for (const cleanup of cleanups) {
    try {
      cleanup()
    } catch (error) {
      fail.push('a disposer threw: ' + error.message)
    }
  }
  if (elementStore.length !== 0) {
    fail.push('the injected stylesheet was not removed on disposal')
  } else {
    note('disposal             : the stylesheet is removed')
  }
  const platform = sandbox.document.documentElement.dataset.platform
  if (platform !== 'win32') {
    fail.push(`disposal left the platform attribute at ${JSON.stringify(platform)}, so dsh's macOS rules would stay on`)
  } else {
    note('disposal             : the platform attribute is restored, so dsh\'s macOS rules switch off again')
  }
}

console.log('')
if (fail.length > 0) {
  console.log('FAIL')
  for (const message of fail) console.log('  - ' + message)
  process.exit(1)
}
console.log('PASS — all checks green')


























