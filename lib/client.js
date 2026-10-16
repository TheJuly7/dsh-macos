/**
 * dsh-macos — browser half.
 *
 * dsh already ships its own macOS styling — 21 rules scoped by `[data-platform=darwin]` —
 * covering the transparent frame, the sidebar column's translucent fill, the hairline the
 * content column draws against the sidebar, the translucent new-session button and a
 * non-clickable brand row. That styling is what the reference shows, and the platform
 * attribute the preload writes on <html> is the only switch for it, so this plugin reports
 * the platform as darwin (see apply) and then supplies only what the macOS window server
 * provides on a real Mac and Windows has no equivalent for:
 *
 *   1. Traffic lights. macOS draws them; Windows instead draws caption buttons in the top
 *      right, which this plugin hides. The three dots are drawn here and driven from the
 *      host half, which reaches the OS window through Win32.
 *
 *   2. A blur and a backdrop. On macOS the window is transparent and the window server blurs
 *      the desktop through it. Here the window is opaque and no plugin can change that
 *      (window transparency, backgroundMaterial and backgroundColor are main-process
 *      options), so the backdrop is painted by this sheet and the blur is a backdrop-filter
 *      on a pseudo-element of the frame. That is also why the sidebar fill is thinned: on a
 *      Mac it is 90% opaque over the system's vibrancy, and 90% over nothing is just opaque.
 *
 *   3. The reserved title strip is collapsed, and the window menu is hidden. Both belong to
 *      Windows: the strip is the band dsh reserves for the platform's caption buttons, and
 *      the menu is a shadow-DOM host whose styles cannot be reached, so hiding it is the
 *      only thing a skin can do. Its items — About, copy/paste, quit — go with it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-macos',
  factory(require) {
    const React = require('react')
    const { useEffect, useState } = React
    const h = React.createElement

    /* Window commands go to the host half, which drives the real OS window through Win32.
     * When that is unavailable — a non-Windows host, or the FFI binding failing to load —
     * close still works through window.close() and zoom through the Fullscreen API; anything
     * with no fallback is disabled rather than pretending to work. */
    const WINDOW_ROUTE = '/plugins/dsh-macos/window'
    const REQUEST_TIMEOUT = 1500

    function windowCommand(action) {
      // Every command races a timeout and resolves to null, which the fallbacks read as "no
      // host". Without it a request that never settles would leave a control looking dead
      // instead of falling back.
      const settled = new Promise((resolve) => setTimeout(() => resolve(null), REQUEST_TIMEOUT))
      const request = fetch(WINDOW_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null)
      return Promise.race([request, settled])
    }

    const CSS = `
/* 1 ── the backdrop the window sits on ---------------------------------------- */
/* One step away from the pane's own colours, so the window's rounded corners and shadow read
   as an edge: at dsh's own values (#e9eaee / #1a1c20) the backdrop was within a few percent of
   the content column, which made the radius invisible and the shadow imperceptible.
   What dsh's darwin styling shows through: its frame is transparent and its sidebar column
   is a translucent fill, so this is the layer underneath both. Flat and achromatic, because
   anything else reads as a colour cast or a top-to-bottom ramp through the glass. */
html,body{background:#d7dae0 !important}
html:has(body[data-ds-dark-theme]),html:has(body[data-ds-dark-theme]) body{background:#0b0c0f !important}

/* 2 ── the window, with no strip above it ------------------------------------- */
/* The reserved strip drives the frame's padding-top and the drag-only pseudo-element; the
   preload sets the variable inline, and an !important rule beats inline, so zeroing it is
   what pulls the sidebar and the content up to the window's top edge. */
html[data-windows-titlebar]{
  --dsh-windows-titlebar-height:0px !important;
  --dsh-macos-glass-edge:rgba(255,255,255,.6);
  --dsh-macos-glass-inner:rgba(255,255,255,.3)}body[data-ds-dark-theme]{
  --dsh-macos-glass-edge:rgba(255,255,255,.1);
  --dsh-macos-glass-inner:rgba(255,255,255,.06)}
/* The pane keeps only its shape: the fill comes from dsh's darwin rules. The frame is
   isolated so the blur layer below paints deterministically between the window's background
   and its children; filter, transform or contain would instead make it a containing block
   for the fixed-position window chrome ui-layout renders inside [data-shell-overlay].
   It is selected by dsh's own class rather than by the structural :has() form: that once
   matched a much larger container after a client-module reload, which painted the blur layer
   across a third of the window. The class is in the surface snapshot, so a build that renames
   it fails verify.mjs instead of misbehaving quietly. */
html[data-windows-titlebar] .BynINW_frame{
  position:relative;
  isolation:isolate;
  border-radius:11px;
  box-shadow:0 0 0 .5px rgba(0,0,0,.45),0 20px 54px rgba(0,0,0,.5)}
/* The blur the window server would provide. A pseudo-element rather than a filter on the
   sidebar element, because the sidebar holds a fixed-position toggle and a filter on that
   element would re-parent it; painted at z-index:-1 so it stays behind the rows. It carries
   no tint — the colour is dsh's sidebar fill — only the blur, a fine grain and the light
   catching its top edge. It shares its pseudo-element with dsh's strip, whose
   \`height:var(--dsh-windows-titlebar-height)\` would otherwise confine it to that band, so
   \`height:auto\` is load-bearing. The grain is an inline SVG turbulence: no network, no asset.
*/
html[data-windows-titlebar] .BynINW_frame:before{
  content:'';
  position:absolute;
  inset:0;
  height:auto;
  z-index:-1;
  border-radius:11px;
  pointer-events:none;
  -webkit-app-region:no-drag;
  backdrop-filter:blur(28px) saturate(180%);
  -webkit-backdrop-filter:blur(28px) saturate(180%);
  box-shadow:inset 0 1px 0 var(--dsh-macos-glass-edge);
  background:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='140' height='140' filter='url(%23g)' opacity='0.055'/></svg>")}
/* That pseudo-element was also the window's only drag region, and the band it drew is gone.
   The grab area is a stretch of the sidebar's header row — the brand line, which dsh's darwin
   rules already make non-clickable — and it is deliberately inset at both ends: clear of the
   window controls on the left, and clear of the sidebar's own toggle on the right.
   That inset is load-bearing, not cosmetic. Chromium computes the draggable region from the
   element tree, and a no-drag declaration only carves a hole when it is set on an element
   *inside* the region. The controls and the toggle live in sibling subtrees (the overlay layer
   and the sidebar), so their own no-drag rules cannot exempt them: a band drawn over them
   swallows every click, which is exactly what happened. */
html[data-windows-titlebar] .BynINW_frame:after{
  content:'';
  position:absolute;
  top:0;
  left:88px;
  width:max(0px,calc(var(--dsh-windows-sidebar-width,280px) - 180px));
  height:34px;
  z-index:1;
  -webkit-app-region:drag}

/* 3 ── the sidebar, and the controls that lived in the strip ------------------- */
/* The one place this sheet touches a fill dsh's darwin rules own, and it is a substitution
   rather than a competing design: on macOS that fill is 90% opaque and sits over the window
   server's vibrancy, so the desktop shows through it. Windows has no such vibrancy, and 90%
   over this plugin's blur layer would simply be opaque, so the fill is thinned to let the
   blur do the work the window server does on a Mac. */
html[data-windows-titlebar] .BynINW_sidebarCol{
  background:color-mix(in srgb, var(--dsw-specific-sidebar-fill) 70%, transparent) !important}
/* The light inner hairline that gives the glass a boundary, beside the divider. */
html[data-windows-titlebar] ._2H3hWW_root{box-shadow:inset -1px 0 0 var(--dsh-macos-glass-inner)}
/* The sidebar's new-session button takes its radius from dsh's --dsw-radius-md token, which is
   tighter than a Mac's. The expanded button is 38px tall, so it gets 12; the collapsed one is a
   28px circle and is left exactly as dsh draws it. Scoped rather than redefining the token, so
   nothing else in the client inherits a different radius. */
html[data-windows-titlebar] ._2H3hWW_root:not(._2H3hWW_collapsed) ._2H3hWW_newSession{border-radius:12px}
/* dsh rounds the content column's top-left corner with --dsh-windows-content-radius (16px on
   Windows), which cuts a visible curve into the seam where the sidebar and the content meet.
   macOS joins the two flush, so that one corner is squared here. The window's own top-right
   corner is unaffected: it comes from the pane's border-radius, clipped by its overflow. */
html[data-windows-titlebar] .BynINW_centerCol{border-top-left-radius:0 !important}
/* dsh reserves 160px before its own controls, and that number is load-bearing rather than
   generous: shrinking it to the 84px the dots actually occupy was measured to push the seat's
   controls onto the session title.
   With the sidebar collapsed, dsh's Windows-only rules pin the toggle to 12px and the
   new-session button to 48px — positions that assume the platform draws nothing at the window's
   top left. This plugin draws the traffic lights there, so both move into the room dsh keeps for
   them, in the row's order: the three dots, the sidebar toggle, the new-session button, then the
   title. They are given the same box and the same top edge: the new-session button carries a
   margin of its own for the rail, which otherwise left it 8px lower and 3px narrower than the
   toggle beside it. Expanded, both stay where dsh's macOS layout puts them — the toggle in the
   sidebar's header and the new-session button inside the sidebar. */
/* The two families appear in different states, so exactly one of them is kept in each.
   Collapsed, dsh renders the toggle and the new-session button itself — its own component family,
   in the band right after the window controls at 88 and 124, which is the row the reference shows.
   The sidebar plugin renders its own copies as well, and dsh's Windows-only rules park those in
   the same band, because their position is computed from the title strip's height, now zero. Two
   families in one row at slightly different offsets is what made each control look duplicated, so
   the plugin's copies are dropped — but only while collapsed: expanded, dsh renders no band
   controls at all, and the sidebar's own two are the only ones there are. */
html[data-windows-titlebar] ._2H3hWW_collapsed ._2H3hWW_toggle,
html[data-windows-titlebar] ._2H3hWW_collapsed ._2H3hWW_newSession{display:none !important}
/* Expanded, the sidebar keeps its own two, and they need a top edge: dsh computes theirs from the
   strip height, which is zero here, which would leave the toggle above the window. The toggle sits
   at the sidebar header's trailing edge, as on a Mac; the new-session button stays in the sidebar,
   in the flow, where dsh's own rules already put it. */
html[data-windows-titlebar] ._2H3hWW_root:not(._2H3hWW_collapsed) ._2H3hWW_toggle{
  top:8px;
  left:calc(var(--dsh-windows-sidebar-width,280px) - 40px)}


/* 4 ── the window controls ---------------------------------------------------- */
/* macOS insets its dots 16 from the left and centres them on a 24px row, with a gap of roughly two
   thirds of their diameter. The size here is 16px, matching the visual weight of the controls dsh
   draws beside them (28px buttons around 16px glyphs), and the group still spans only 82px — clear
   of the first of those controls at 88px. The glyphs fill their button box, so this size is stated
   once. They are the drag region's exception, so they opt out of it explicitly. */
.dsh-macos-traffic{position:fixed;top:16px;left:16px;display:flex;align-items:center;gap:9px;z-index:60;-webkit-app-region:no-drag}
/* The reveal is driven by React state, not by these rules: with the sheet missing (a reload can
   leave the component mounted without it) a CSS-only reveal showed all three marks at once. The
   colours stay declared here too, for the case where the sheet is the only thing that loaded. */
.dsh-macos-traffic button{width:16px;height:16px;padding:0;border:0;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:default;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.18)}
.dsh-macos-tl-close{background:#ff5f57}
.dsh-macos-tl-min{background:#febc2e}
.dsh-macos-tl-zoom{background:#28c840}
.dsh-macos-traffic button:disabled{opacity:.45}

/* 5 ── Chromium's title-bar overlay, which otherwise paints the strip ---------- */
/* Electron's titleBarOverlay makes Chromium paint the top 40px, taking its colour from a
   hidden probe element the desktop preload appends to <body>:
     probe.style.cssText = '...background-color:var(--dsw-specific-sidebar-fill);
                             color:var(--dsw-alias-label-primary)'
   read back with getComputedStyle and sent as dsh-desktop:windows-appearance, which the main
   process hands to setTitleBarOverlay. That fill is opaque and seams against the sidebar
   below it. The probe's styles are inline and an !important rule beats inline, so both the
   fill and the glyph colour are overridden. That also makes the platform's caption buttons
   invisible, which macOS does not draw inside a window either; their hit areas remain, since
   the window option that enables them cannot be switched off from a plugin — removing it
   makes the main process throw "Titlebar overlay is not enabled". */
body > span[style*="--dsw-specific-sidebar-fill"]{
  background-color:rgba(0,0,0,0) !important;
  color:rgba(0,0,0,0) !important}

/* 6 ── the stock window menu ------------------------------------------------- */
/* The preload's own menu, with its 应用/编辑 titles and their dropdowns. Hidden rather than
   restyled: its styles live in a shadow root this sheet cannot reach. Its items go with it —
   About, copy/paste and quit — so quit from the tray until a later step draws a replacement
   bar. Delete this one rule to bring the stock menu back. */
html[data-windows-titlebar] [data-windows-menu]{display:none !important}
`

    /* The three dots. Red closes, yellow minimises, green zooms; the glyphs appear on hover,
     * as they do on macOS, and the yellow dot disables itself with an honest tooltip when the
     * host half cannot reach the window. */
    function TrafficLights() {
      const [supported, setSupported] = useState(null)
      // Whether the marks are shown. Driven here rather than by :hover in the sheet, so a render
      // without the sheet cannot leave all three marks visible at once.
      const [hovered, setHovered] = useState(false)
      // One line about the archive edit, when this launch is the one that wrote it.
      const [notice, setNotice] = useState(null)

      useEffect(() => {
        let live = true
        windowCommand('state').then((state) => {
          if (!live) return
          setSupported(state !== null && state.supported === true)
          // The archive edit only takes effect on the next launch, because the window is created
          // before the profile composes. Without a word about it the platform's buttons look like
          // they are still there — and they are: invisible, but still clickable.
          if (state !== null && state.patch !== undefined && state.patch.changed === true) {
            setNotice(state.patch.blocked === true ? 'elevated' : 'restart')
          }
        })
        return () => {
          live = false
        }
      }, [])

      // The controls carry their own geometry. Sizing them from the stylesheet alone was fragile:
      // when the sheet was not applied (a client-module reload triggered by another plugin left the
      // component mounted without it) the glyph filled whatever box it was given and three huge
      // marks covered the window. The dot box, the glyph and the disabled fade are therefore
      // stated here, and the stylesheet only adds the hover transition on top.
      const dot = (className, path, label, colour, onClick, disabled) =>
        h(
          'button',
          {
            type: 'button',
            className,
            title: label,
            'aria-label': label,
            disabled: disabled === true,
            onClick,
            style: {
              width: '16px',
              height: '16px',
              padding: '0',
              border: '0',
              borderRadius: '50%',
              background: colour,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'default',
              opacity: disabled === true ? '0.45' : '1',
              boxShadow: 'inset 0 0 0 .5px rgba(0,0,0,.18)',
            },
          },
          h(
            'svg',
            {
              viewBox: '0 0 12 12',
              width: 16,
              height: 16,
              'aria-hidden': true,
              style: { opacity: hovered ? '0.62' : '0', transition: 'opacity .12s ease' },
            },
            h('path', { d: path, stroke: '#000', strokeWidth: 1.1, strokeLinecap: 'round', fill: 'none' }),
          ),
        )

      const close = () => {
        windowCommand('close').then((result) => {
          if (result !== null && result.supported === true) return
          // The preload's own close path is revision-safe and asks the app to run its
          // shutdown flow; window.close() is the last resort.
          try {
            const desktop = window.dshDesktop
            if (desktop !== undefined && desktop.keyboard !== undefined && typeof desktop.keyboard.closeWindow === 'function') {
              desktop.keyboard.closeWindow()
              return
            }
          } catch {
            /* the bridge is unavailable */
          }
          try {
            window.close()
          } catch {
            /* nothing else to try */
          }
        })
      }

      const zoom = () => {
        windowCommand('zoom').then((result) => {
          if (result !== null && result.supported === true) return
          try {
            if (document.fullscreenElement) document.exitFullscreen()
            else document.documentElement.requestFullscreen()
          } catch {
            /* fullscreen refused */
          }
        })
      }

      const text =
        notice === 'elevated'
          ? '已请求管理员权限：授权后完全重启 DSH，右上角的原生按钮才会消失'
          : notice === 'restart'
            ? '完全重启 DSH 后，右上角的原生按钮才会消失'
            : null

      const traffic = h(
        'div',
        {
          className: 'dsh-macos-traffic',
          // Inline as well as in the sheet: this is the window chrome, and it has to keep its
          // place even if the stylesheet is missing.
          style: {
            position: 'fixed',
            top: '16px',
            left: '16px',
            display: 'flex',
            alignItems: 'center',
            gap: '9px',
            zIndex: '60',
            WebkitAppRegion: 'no-drag',
          },
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
        },
        dot('dsh-macos-tl-close', 'M4 4l4 4M8 4l-4 4', '关闭', '#ff5f57', close, false),
        dot(
          'dsh-macos-tl-min',
          'M3.5 6h5',
          supported === false ? '此宿主不支持最小化' : '最小化',
          '#febc2e',
          () => windowCommand('minimize'),
          supported === false,
        ),
        dot('dsh-macos-tl-zoom', 'M6 3.5v5M3.5 6h5', '缩放', '#28c840', zoom, false),
      )

      if (text === null) return traffic
      // Everything inline again, so the notice survives a missing stylesheet. The colours come from
      // the app's own aliases where they exist, and fall back to a dark surface that reads on either
      // appearance.
      return h(
        React.Fragment,
        null,
        traffic,
        h(
          'div',
          {
            className: 'dsh-macos-notice',
            style: {
              position: 'fixed',
              left: '16px',
              bottom: '16px',
              maxWidth: '340px',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
              padding: '10px 12px',
              borderRadius: '10px',
              background: 'var(--dsw-specific-sidebar-fill, rgba(30,30,34,.94))',
              color: 'var(--dsw-alias-label-primary, #f2f2f4)',
              font: '12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
              boxShadow: '0 10px 30px rgba(0,0,0,.45), inset 0 0 0 .5px rgba(255,255,255,.08)',
              zIndex: '70',
              WebkitAppRegion: 'no-drag',
            },
          },
          h('span', { style: { flex: '1' } }, text),
          h(
            'button',
            {
              type: 'button',
              title: '关闭提示',
              'aria-label': '关闭提示',
              onClick: () => setNotice(null),
              style: {
                border: '0',
                padding: '0',
                background: 'transparent',
                color: 'inherit',
                opacity: '0.55',
                cursor: 'pointer',
                fontSize: '14px',
                lineHeight: '1',
              },
            },
            '×',
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // This half is declared for the web platform, so it also loads in a plain browser, where
        // there is no Windows frame to dress and no host to drive. Both the desktop shell's
        // preload and its frame attribute are checked, because either may be the one present at
        // the moment plugins apply.
        const desktop =
          typeof window.dshDesktop !== 'undefined' || document.documentElement.hasAttribute('data-windows-titlebar')
        if (!desktop) return
        // The reload path does not always dispose the previous instance, and two live instances
        // mean two stylesheets and two sets of dots. The previous one is therefore undone *before*
        // the new one installs: its disposer restores the platform attribute, so running it
        // afterwards would silently switch dsh's macOS styling back off — which is exactly how the
        // layout reverted to its Windows arrangement once.
        try {
          const previous = window.__dshMacos
          if (previous !== undefined && typeof previous.dispose === 'function') previous.dispose()
        } catch {
          /* the previous instance is already gone */
        }
        window.__dshMacos = { dispose: install(ctx) }
      },
    }

    function install(ctx) {
      const disposers = []
      /** Register an effect and remember how to undo it. */
      const effect = (body, label) => {
        ctx.effect(() => {
          const returned = body()
          const cleanup = typeof returned === 'function' ? returned : () => {}
          const run = () => {
            try {
              cleanup()
            } catch {
              /* already disposed */
            }
          }
          disposers.push(run)
          return run
        }, label)
      }

      // Report the platform as darwin. That single attribute is what switches dsh's own macOS
      // styling on — the transparent frame, the sidebar column's translucent fill, the hairline
      // the content column draws, the translucent new-session button and the non-clickable brand
      // row. Only two helpers in the client test for it (a transition watcher and a small
      // predicate), both enhancements, and the previous value is restored when the plugin
      // unloads.
      effect(() => {
        const root = document.documentElement
        const previous = root.dataset.platform
        root.dataset.platform = 'darwin'
        return () => {
          if (previous === undefined) delete root.dataset.platform
          else root.dataset.platform = previous
        }
      }, 'dsh-macos: report darwin')

      effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-dsh-macos', 'window')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => {
          style.remove()
        }
      }, 'dsh-macos: window')


      // The controls mount into the overlay layer ui-layout renders inside
      // [data-shell-overlay]; the slot passes no props of its own.
      effect(
        () =>
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register({ name: 'shell.overlay', id: 'macos-traffic-lights', order: 10 }, () => h(TrafficLights, null)),
          ),
        'dsh-macos: window controls',
      )

      return () => {
        for (const run of disposers.splice(0)) run()
      }
    }
  },
})




