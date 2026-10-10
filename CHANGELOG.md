# Changelog

## 1.2.0 — 2026-10-11

首个以 1.2 命名的版本（内容与 0.1.2 相同）。

- **三个圆点**：16px 圆点、9px 间距、距左 16、垂直中心 24px；红＝关闭、黄＝最小化、绿＝缩放，悬停显示字形，宿主不支持最小化时黄点自动禁用。
- **平台翻转**：以 `data-platform="darwin"` 运行，复用 DSH 内置的 macOS 样式（透明外框、侧边栏半透明填充、内容列分隔线等），卸载时还原。
- **磨砂玻璃**：面板上的模糊/饱和层、内高光边线、颗粒噪点与投影；侧边栏半透明材质（DSH 的 darwin 填充按 70% 稀释，因为 Windows 没有窗口 vibrancy 可透）。
- **窗口外壳**：标题条预留高度置 0（内容顶到上沿）、窗外中性底色（深 `#0b0c0f` / 浅 `#d7dae0`）、窗口四角 11px 圆角、两块接缝（内容列左上角）压平为直角。
- **原始菜单条被清理**：`应用 / 编辑` 那条菜单与三个圆点位置重叠，用 `SetMenu` + `DrawMenuBar` 清除（**不碰**样式位、**不删**菜单项）。
- **控件抗重载**：圆点的盒子、字形尺寸、颜色、位置、禁用透明度全部内联，标记显隐由组件状态驱动 —— 即使样式表缺失（切换其他插件触发的客户端模块重载）也不会变形；面板用 `.BynINW_frame` 类名定位，该类名在 `surface/` 快照里。
- **顶栏控件排序**：折叠态 `三个圆点 → 折叠按钮 → 新会话 → 会话名`；展开态折叠按钮回到侧边栏标题行右端、新会话留在侧边栏内。
- **彻底移除 Windows 标题栏按钮**：通过 app.asar 内**两次同长度改名**（主窗口 `titleBarOverlay` 选项 + preload 上报标题栏颜色的 IPC 频道）让平台不再创建那个覆盖层；加载时施加、卸载时还原，`DSH_MACOS_NO_BUNDLE_PATCH=1` 可整体关闭。
- **宿主窗口路由**：`POST /plugins/dsh-macos/window`，仅回环、仅 POST、请求体 ≤ 1 KB、动作白名单，只作用于 `process.ppid` 拥有的可见窗口，Win32 绑定使用 DSH 自带的 Koffi。
- **一键安装**：`install.cmd`（或 `node tools/install.mjs`）自动写 profile 清单（带时间戳备份）、建 `node_modules` 联接、施加归档补丁；卸载用 `uninstall.cmd`（`tools/install.mjs --remove`）。
- **工具与自检**：`verify.mjs`（44 项检查）、`tools/profile.mjs`、`tools/bundle-patch.mjs`、`tools/extract-dsh-surface.mjs`。

### 维护者笔记

- **插件页那句"无法从依赖变更中确定安装了哪一个包"**：它按**包名**判断是否新增，包名已在 profile 里时必然误报（换标签也一样），此时 pnpm 其实已装好。想不看到就先卸载再安装，或走手动安装。
- **两条安装路线不能混用**：`install.cmd` 用 `link:`，插件页从 git 安装是复制；已存在联接时 pnpm 会报 `ERR_PNPM_EPERM`（此时 profile 条目已被移除，跑一次 `install.cmd` 即可修回）。
- **宿主位置与归档**：宿主子进程的 `argv[2]` 是宿主入口脚本、`argv[3]` 才是 runtimeDir，`process.execPath` 是 node 二进制 —— 归档位置由入口路径里的 `.asar` 截取得到。
- **哪些改动要重启**：改 `lib/client.js`（浏览器半）保存即热重载；改 `lib/index.js`（宿主半）或归档补丁需**完全重启**。
