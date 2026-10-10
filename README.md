# dsh-macos

把 Windows 版 **DeepSeek Harness 桌面客户端**做成 macOS 版的样子：红黄绿三个圆点、可折叠的磨砂侧边栏、两块之间齐平的接缝，并且**完全没有 Windows 标题栏按钮**。

只作用于桌面客户端（Windows）；网页版不受影响（插件会自行判断并退出）。原理是复用 DSH 内置的 darwin 样式，只补上 macOS 由**系统**提供、Windows 没有的部分。

## 安装

1. 把仓库放到任意目录，例如 `D:\plugins\dsh-macos`；
2. **双击 `install.cmd`**（或在终端里 `node tools\install.mjs`）——它会把插件写进 profile、建好 `node_modules` 联接、并隐藏标题栏按钮；
3. **完全退出并重新打开** DSH。

| 要求 | |
|---|---|
| 系统 | Windows 10 / 11 |
| 应用 | DeepSeek Harness 桌面客户端（在 0.2.0-rc.2 上验证） |
| Node | ≥ 20（仅安装与脚本需要） |

安装器可重复运行（已装好时只报告、不写文件）。常用参数：`--dry-run` 只报告会改什么；`--profile <名字>` 指定 profile；`--no-patch` 不动 app.asar；`--force` 当 profile 已指向另一份副本时强行切换。

### 也可以用「设置 → 插件」从 git 安装

两种装法**只能选一种**：`install.cmd` 用 `link:`（改代码即时生效，本仓库推荐）；从 git 地址安装则是**复制**一份快照。若之前用过 `install.cmd`，先删掉它建的联接，否则 pnpm 无法覆盖（会报 `ERR_PNPM_EPERM`）：

```powershell
cmd /c rmdir "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-macos"
```

反过来也一样：从 git 装过之后想改用 `install.cmd`，先删掉那份复制品（联接也好、实体目录也好，删的都是 `node_modules\dsh-macos` 这一项）。

> ⚠️ 插件管理里的安装**失败**时会把 profile 里的条目先移除再回滚——若失败后插件"消失"，跑一次 `install.cmd` 即可修回。

## 卸载

在 **设置 → 插件** 里移除 `dsh-macos`，然后完全重启。若重启后标题栏按钮**没有**回来（说明归档补丁还在）：

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
| `node verify.mjs` | 36 项自检 |
| `node tools/install.mjs --dry-run` | 看安装器会改什么 |
| `node tools/bundle-patch.mjs status` | 查看/还原归档补丁 |
| `node tools/extract-dsh-surface.mjs` | DSH 升级后刷新类名/槽位快照 |

改 `lib/client.js`（浏览器半）保存即**热重载**；改 `lib/index.js`（宿主半）或归档补丁需要**完全重启**。

## 许可

MIT，见 [LICENSE](./LICENSE)。
