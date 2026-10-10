# dsh-macos

把 **DeepSeek Harness 桌面客户端（Windows）** 做成 macOS 版的样子与手感：左上角红黄绿三个圆点、可折叠的磨砂侧边栏、两块之间齐平的接缝，以及被彻底移除的 Windows 标题栏按钮。

> 只在**桌面客户端（Windows）**生效。插件会先判断自己是否运行在桌面外壳里，网页版不受影响。
> 原理上是复用 DSH 内置的 darwin 样式（`data-platform="darwin"` 那套规则），插件只补上 macOS 由**系统**提供、Windows 没有的部分。

---

## 效果

- **左上角三个圆点**：16px 圆点、9px 间距、距左 16 / 垂直居中于 24px 那一行（macOS 的位置比例）。红＝关闭、黄＝最小化、绿＝缩放，悬停显示 ✕ / − / ＋。
- **彻底没有 Windows 标题栏按钮**：不是遮挡，而是让平台不再创建那个覆盖层（见下方"它改了什么 / app.asar 补丁"）。
- **侧边栏**：折叠时在顶栏排成一行 `三个圆点 → 折叠按钮 → 新会话 → 会话名`；展开时折叠按钮回到侧边栏标题行右端、新会话按钮留在侧边栏内（macOS 的排布）。
- **两块之间的接缝是直角**（macOS 就是齐平的），窗口四角 18px 圆角。
- **磨砂玻璃**：侧边栏是半透明材质叠在模糊层上，配 1px 内高光边线，窗口有投影。
- **深/浅色都跟主题**：窗外底色深色 `#0b0c0f`、浅色 `#d7dae0`（中性灰，不带蓝）。

## 安装

### 前置

| 项 | 要求 |
|---|---|
| 系统 | Windows 10 / 11 |
| 应用 | DeepSeek Harness 桌面客户端（在 **0.2.0-rc.2** 上开发与验证） |
| Node | ≥ 20（只有跑校验脚本和维护工具时才需要） |

### 方式一：写进 profile（推荐）

1. 把本仓库放到任意目录，例如 `D:\plugins\dsh-macos`。
2. 打开 profile 目录：`%USERPROFILE%\.dsh\profiles\desktop`（其它 profile 同理）。
3. 编辑该目录下的 `package.json`：

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-macos"]
       }
     },
     "dependencies": {
       "dsh-macos": "link:D:/plugins/dsh-macos"
     }
   }
   ```

4. 让 `node_modules/dsh-macos` 指向插件目录：在 profile 目录跑 `pnpm install`（`link:` 会由 pnpm 建好），或者手工建一个目录联接：

   ```powershell
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-macos" -Target "D:\plugins\dsh-macos"
   ```

5. **完全退出并重新启动 DSH。** 宿主半侧与 app.asar 补丁只在启动时生效，仅关掉窗口（最小化到托盘）不算重启。

### 方式二：交给 DSH 的插件管理

在 **设置 → 插件** 里添加 `dsh-macos`。无论用哪种方式，装完都要按上面的第 5 步**完全重启**。

### 安装成功的判断

- 左上角出现三个圆点，且顶栏没有 Windows 的 ❐ ✕ 按钮；
- 在插件目录执行 `node verify.mjs`，**33 项检查**应全绿；
- 想确认 app.asar 补丁状态：`node tools/bundle-patch.mjs status`（见下）。

## 卸载与还原

1. 从 profile 的 `bundles` 和 `dependencies` 里移除 `dsh-macos`，并删掉 `node_modules\dsh-macos`，然后**完全重启**。
2. 插件卸载时会自动把 app.asar 改回原样。若应用被强杀（没走到卸载），或你想手工确认/还原：

   ```powershell
   node tools/bundle-patch.mjs status     # 看当前状态
   node tools/bundle-patch.mjs restore    # 还原两个改名
   node tools/bundle-patch.mjs hide       # 反向：重新移除标题栏按钮
   ```

   也可以直接传 app.asar 路径：`node tools/bundle-patch.mjs status "D:\...\resources\app.asar"`。

3. 只想让插件**别动** app.asar（保留其它功能）：启动应用时带环境变量 `DSH_MACOS_NO_BUNDLE_PATCH=1`。

## 它改了什么

| 位置 | 做法 |
|---|---|
| 窗口外壳 | 让客户端以 `data-platform="darwin"` 运行 —— 这是 DSH **自己内置**的 macOS 样式开关（透明外框、侧边栏半透明填充、内容列分隔线等 21 条规则），插件卸载时还原原值 |
| 磨砂层 | 面板上的模糊/饱和层 + 颗粒噪点 + 内高光边线（macOS 上这些由窗口服务器提供，Windows 没有） |
| 窗外底色 | 注入一层中性底（深/浅各一），让窗口边缘、圆角与投影能被看见 |
| 顶部留白 | 把标题条预留高度置 0，让内容顶到窗口上沿（否则顶上永远空 40px） |
| 三个圆点 | 浏览器半侧绘制并挂到 `shell.overlay` 槽位；窗口动作走宿主半侧的 Win32 路由 |
| 侧边栏控件 | 折叠/展开两态下 DSH 会渲染**两套**控件（`_2H3hWW_*` 与 `DuqLHW_*`），插件按状态取舍，避免重复 |
| 标题栏按钮 | **app.asar 内两次同长度改名**：主窗口的 `titleBarOverlay` 选项，以及 preload 上报标题栏颜色的 IPC 频道（只改名不改长度，不动归档结构） |

## 已知限制（请务必读）

- **"透明"是模拟的。** Windows 没有 macOS 的窗口 vibrancy，窗口本身不透明：插件是在窗口内部画一层底 + 模糊 + 半透明材质。所以侧边栏是"看起来像玻璃"，不是真的能看见桌面。
- **窗口最外缘那圈圆角由 Windows 画**（DWM，约 8px），页面改不动它。页面自己的圆角（18px）只有在**窗外底色与窗口内容有对比**时才看得出来——如果觉得"圆角没生效"，先看这一条。
- **app.asar 补丁与应用更新**：补丁是**改安装目录里的文件**，插件每次加载都会重新确认/施加，所以升级 DSH 后**重启一次即可重打**。若应用装在 `Program Files` 这类受保护目录，需要**管理员权限**启动一次（或管理员身份跑 `tools/bundle-patch.mjs hide`）。
- **加载失败会被应用自动禁用**：如果插件在启动时抛错，DSH 的恢复流程可能往 profile 的 `cordis.patch.yml` 写入

  ```yaml
  - id: dsh-macos
    disabled: true
  ```

  这会让插件"看起来失效"。删掉这两行再重启即可。
- **中文字体**走系统回退（未内嵌 CJK 字体），与真机 macOS 的字体观感会有差距。
- **三个圆点是自绘的**（Windows 没有原生交通灯），因此悬停字形、点击热区、禁用态都由插件负责；原生窗口的 DWM 行为（贴边、Aero Snap 等）不受影响。
- **DSH 升级后可能需要小改**：插件依赖若干 DSH 内部类名（`BynINW_*`、`_2H3hWW_*`、`DuqLHW_*`）与槽位契约。升级后先跑 `node verify.mjs`，再用 `node tools/extract-dsh-surface.mjs` 刷新 `surface/` 快照对照。

## 安全说明

宿主半侧做的事都在 OS 窗口层面，边界刻意收得很窄：

- 路由挂在 **仅回环** 的本地 web server 上：`POST /plugins/dsh-macos/window`；
- **只接受 POST**，请求体上限 **1 KB**，动作是白名单（`state` / `close` / `minimize` / `zoom`）；
- 调用方**不能**指定窗口：插件只作用于 **`process.ppid` 拥有的可见窗口**（即应用主窗口），句柄不出进程；
- Win32 调用通过 DSH **自带**的 Koffi 绑定完成，不额外下载二进制；不改渲染进程权限、不打开 `nodeIntegration`。

## 开发

```powershell
node verify.mjs                        # 33 项检查，全绿才算通过
node tools/extract-dsh-surface.mjs     # DSH 升级后刷新类名/槽位快照
node tools/bundle-patch.mjs status     # 只读查看 app.asar 补丁状态
```

改动生效方式：

| 改哪半 | 生效方式 |
|---|---|
| `lib/client.js`（浏览器半） | **热重载**，保存即生效 |
| `lib/index.js`（宿主半） | 需要**完全重启**应用 |
| app.asar 补丁 | 需要**完全重启**应用 |

`verify.mjs` 覆盖的内容：清单/包名/槽位契约、CSS 契约（圆点几何不得挤到 88px、两块接缝必须压平、折叠态必须隐藏重复的那一套控件）、路由**真执行**（405 / 200 / JSON 形状）、bundle 改名幂等与可还原、二次 `apply()` 不得丢 darwin、卸载后样式与属性都要还原。

## 目录结构

```
dsh-macos/
├── lib/
│   ├── index.js        宿主半：app.asar 补丁 + Win32 窗口路由
│   └── client.js       浏览器半：样式表 + 三个圆点 + 平台翻转
├── cordis.patch.yml    宿主平面的一行（id 必须等于包名 dsh-macos）
├── locale/{en,zh}.json 名称与描述
├── surface/            对某个 DSH 版本的类名/槽位快照（维护用）
├── tools/
│   ├── bundle-patch.mjs      查看/还原 app.asar 补丁
│   └── extract-dsh-surface.mjs  刷新快照
├── verify.mjs          33 项自检
└── package.json
```

## 许可

MIT，见 [LICENSE](./LICENSE)。

---

## English summary

A DeepSeek Harness desktop plugin that gives the Windows client the macOS look: traffic lights,
a collapsible frosted sidebar, a flush seam between the two parts, and no caption buttons at all.

**Install:** add `dsh-macos` to `dsh.profile.bundles` and a `link:`/`file:` dependency in the
profile's `package.json` (`%USERPROFILE%\.dsh\profiles\desktop`), make `node_modules/dsh-macos`
resolve to this folder, then **fully restart** the app. `node verify.mjs` runs 33 checks.

**How it works:** it reports the platform as `darwin`, which switches on the macOS styling DSH
already ships, and adds what macOS normally gets from the OS — a blur layer, edge highlights, a
backdrop, the traffic lights themselves, and a narrow Win32 route for the window commands. The
caption buttons are removed by renaming two equal-length strings inside the installed `app.asar`
(the window option and the preload's title-bar channel), which the plugin applies on load and
undoes on unload; `DSH_MACOS_NO_BUNDLE_PATCH=1` opts out, and `tools/bundle-patch.mjs` reports or
restores it by hand.

**Known limits:** window vibrancy does not exist on Windows, so the "glass" is simulated inside an
opaque window; the outermost ~8px of corner rounding is drawn by the window manager, not the page;
an app update needs one restart so the bundle edit is re-applied; and if the plugin ever fails to
load, the app may write `disabled: true` for it into the profile's `cordis.patch.yml` — remove that
entry to bring it back.




