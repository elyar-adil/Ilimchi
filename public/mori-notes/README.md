# Mori Notes

一个单 HTML 的 Markdown 笔记应用，交互参考 Bear 一类的原生笔记工具：三栏布局、即时搜索、标签、收藏、Markdown 编辑/预览、快捷键和动物图标主题。应用不需要后端，也不依赖构建步骤。

## 文件

- `index.html`：完整应用，CSS、JavaScript 和 12 个动物图标都内嵌在同一个 HTML 文件里。

## GitHub Pages

把 `index.html` 放到任意 GitHub Pages 静态站点目录就能发布。本站当前发布路径是：

- 源码：`https://github.com/elyar-adil/Ilimchi/tree/main/public/mori-notes`
- 页面（Pages 工作流部署完成后）：`https://elyar-adil.github.io/Ilimchi/mori-notes/`

## 跨设备同步

Mori 直接调用 GitHub Contents API，把每篇笔记保存为私有仓库指定目录下的 `.md` 文件。正文为普通 Markdown，并在文件头部用 HTML 注释保存 Mori 的少量元数据；其他 Markdown 编辑器仍可正常阅读正文。

1. 在 GitHub 创建一个**私有仓库**（例如 `yourname/private-notes`）。
2. 创建 fine-grained personal access token：Repository access 只选该私有仓库，Repository permissions → Contents 设为 `Read and write`。
3. 打开 Mori → 设置 → 填写 `owner/repo`、笔记目录和 token，点击“保存并连接”。
4. 在另一台设备打开同一个网页，输入相同仓库和 token，即可同步。

默认设置指向 `elyar-adil/paper-notes-data` 下的 `mori-notes/` 目录；建议使用你自己的私有仓库。令牌默认仅保存在当前会话。选择“记住在此设备”时，令牌会通过 Web Crypto AES-GCM 加密后存入 IndexedDB；应用不会把令牌写入源码、笔记仓库或 `localStorage`。令牌会直接发送到 `api.github.com` 以完成授权请求。

应用拒绝连接公开仓库，以免误把笔记公开。每篇笔记使用独立 `.md` 文件；编辑后自动保存到本机，连接 GitHub 后会延迟合并同步。建议只授予笔记仓库的最小权限，并妥善保管个人访问令牌。

## 功能

- 创建、编辑、搜索、收藏、置顶、复制、导入和导出 Markdown 笔记
- 标签筛选与标签管理、最近编辑、回收站
- Markdown 工具栏和阅读预览
- 12 款可选动物图标，以及深色/浅色外观
- 本地优先；GitHub Contents API 同步
- `⌘/Ctrl + K` 搜索、`⌘/Ctrl + N` 新建笔记、`⌘/Ctrl + S` 同步

## 隐私提示

笔记在首次使用时只保存在当前浏览器。连接 GitHub 后，笔记内容会写入所配置的私有仓库，并通过 GitHub 在已授权设备之间同步。不要在不信任的设备上选择记住令牌。