# dsh-macos

把 Windows 版 **DeepSeek Harness 桌面客户端**做成 macOS 版的样子：红黄绿三个圆点、可折叠的磨砂侧边栏、两块之间齐平的接缝，并且**完全没有 Windows 标题栏按钮**。

只作用于桌面客户端（Windows）；网页版不受影响（插件会自行判断并退出）。原理是复用 DSH 内置的 darwin 样式，只补上 macOS 由**系统**提供、Windows 没有的部分。

## 安装

两种装法**只能选一种**，别混用。

### 方式一：在「插件」页里从 git 安装（推荐给使用者）

打开**左侧栏的「插件」页**（不是"设置 → 插件"：那里只列内置插件），添加**带标签**的地址并安装：

```
https://github.com/TheJuly7/dsh-macos.git#v0.1.0
```

**为什么带 `#标签`**：

- 每次发版都会换标签（`v0.1.0` → `v0.1.1` …），所以对你来说"依赖确实变了" ✓ —— 插件页的安装后判定（对比依赖差集找新增包）不会误报"无法从依赖变更中确定安装了哪一个包" ✗（用浮动分支地址时它一定会误报，尽管安装其实成功）；
- 锁文件记录的是**标签对应的确切提交** ✓，不会出现"内容是新的、记录是旧的"这种错位。

装好后**完全退出并重新打开** DSH。这种方式由客户端自己管理，插件会出现在那一页的列表里，升级和卸载都在那里操作。

升级到新版本：插件页里**卸载 → 用新标签重新安装**（例如 `#v0.1.1`）✓。

### 方式二：`install.cmd`（推荐给要改代码的人）

1. 把仓库放到任意目录，例如 `D:\plugins\dsh-macos`；
2. **双击 `install.cmd`**（或在终端里 `node tools\install.mjs`）——它会把插件写进 profile、建好 `node_modules` 联接、并隐藏标题栏按钮；
3. **完全退出并重新打开** DSH。

因为用的是 `link:`，改 `lib/client.js` 保存即生效（宿主半侧仍需重启）。安装器可重复运行（已装好时只报告、不写文件），常用参数：`--dry-run` 只报告；`--profile <名字>` 指定 profile；`--no-patch` 不动 app.asar。

### 从一种装法换到另一种

先删掉 `node_modules\dsh-macos` 这一项（联接或副本都删它），否则 pnpm 无法覆盖（会报 `ERR_PNPM_EPERM`）：

```powershell
cmd /c rmdir "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-macos"
```

> ⚠️ 插件页里的安装**失败**时会把 profile 里的条目先移除再回滚——若失败后插件"消失"，跑一次 `install.cmd` 即可修回。

| 要求 | |
|---|---|
| 系统 | Windows 10 / 11 |
| 应用 | DeepSeek Harness 桌面客户端（在 0.2.0-rc.2 上验证） |
| Node | ≥ 20（仅 `install.cmd` 与脚本需要） |

## 卸载

先看**左侧栏「插件」页**的列表里有没有 `dsh-macos`（macOS 外壳）：有就在那里卸载；`link:` 方式装的插件不总出现在该列表里，那就用仓库里的卸载脚本：

```powershell
uninstall.cmd                                              # 或 node tools\install.mjs --remove
```

它会移除 profile 条目（带备份）、删掉联接、还原归档补丁。之后完全重启。

若重启后标题栏按钮**没有**回来（说明归档补丁还在）：

```powershell
node tools/bundle-patch.mjs status     # already = 补丁仍在
node tools/bundle-patch.mjs restore    # 还原
```

## 它改了什么

- 让客户端以 `data-platform="darwin"` 运行 —— DSH **自己内置**的 macOS 样式开关，卸载时还原；
- 补上 macOS 由系统提供的部分：模糊与颗粒层、内高光边线、与窗口内容拉开一档的窗外底色、标题条预留归零、18px 窗口圆角、接缝压平；
- 自绘三个窗口控件（16px 圆点、9px 间距、距左 16）：红=关闭、黄=最小化、绿=缩放；
- **app.asar 内两处同长度改名**（主窗口 `titleBarOverlay` + preload 的外观 IPC 频道），让平台不再创建标题栏按钮覆盖层。加载时施加、卸载时还原，两处都带上下文校验，`DSH_MACOS_NO_BUNDLE_PATCH=1` 可整体关闭；
- 窗口命令走**仅回环**的 POST 路由（请求体 ≤1 KB、动作白名单，只作用于本进程父窗口的可见窗口）。

## 已知限制

- **"透明"是模拟的**：Windows 没有窗口 vibrancy，玻璃感是在不透明窗口内部画出来的；
- 窗口最外缘约 8px 的圆角由 Windows（DWM）绘制，页面改不动它；
- **app.asar 补丁在应用升级后需要重启一次**重新施加；装在 `Program Files` 时需管理员权限；
- 若插件加载失败，应用可能往 profile 的 `cordis.patch.yml` 写入 `disabled: true`，删掉该条目再重启即可；
- 中文字体走系统回退（未内嵌 CJK）；三个圆点是自绘的（Windows 没有原生交通灯）。

## 开发

| 命令 | 作用 |
|---|---|
| `node verify.mjs` | 37 项自检 |
| `node tools/install.mjs --dry-run` | 看安装器会改什么 |
| `node tools/bundle-patch.mjs status` | 查看/还原归档补丁 |
| `node tools/extract-dsh-surface.mjs` | DSH 升级后刷新类名/槽位快照 |

改 `lib/client.js`（浏览器半）保存即**热重载**；改 `lib/index.js`（宿主半）或归档补丁需要**完全重启**。

### 发版流程（维护者）

```powershell
# 1) 改 package.json 的 version，并把这次改动写进 CHANGELOG.md
# 2) 提交并推送
git add -A; git commit -m "release: v0.1.1"; git push origin main
# 3) 打注解标签并推送（使用者按 #v0.1.1 安装）
git tag -a v0.1.1 -m "dsh-macos 0.1.1"; git push origin v0.1.1
```

标签是使用者安装地址的一部分（`…#v0.1.1`），所以**标签名一旦推送就不要移动**：要改内容就发下一个版本号。

## 许可

MIT，见 [LICENSE](./LICENSE)。
