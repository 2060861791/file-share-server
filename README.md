<p align="center">
  <img src="https://raw.githubusercontent.com/twitter/twemoji/master/assets/svg/1f4e1.svg" width="64" height="64" alt="antenna">
</p>

<h1 align="center">文件共享服务器</h1>
<p align="center">File Share Server — 局域网文件共享，手机扫码即访问</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D14-brightgreen" alt="Node.js >= 14">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License MIT">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform">
</p>

---

## ✨ 功能

- 📂 **自动目录索引** — 把文件放进 `file/` 文件夹，自动生成带图标的文件列表
- 📱 **手机扫码访问** — 终端自动打印二维码，手机扫一扫即可浏览/下载
- 🎨 **暗色主题 UI** — 深色界面，响应式布局，手机/PC 均可流畅访问
- 🎬 **视频在线播放** — 支持 HTTP Range，拖拽进度条任意跳转
- 📦 **零配置** — 一条命令启动，无需数据库、无需注册
- 🚀 **开机自启** — 可选 VBS 脚本，无窗口后台运行

## 📸 预览

### 终端启动画面
![终端启动画面](assets/image-224.png)

### Web 界面

![Web 界面](assets/image-227.png)

## 🚀 快速开始

### 前提条件

- [Node.js](https://nodejs.org/) >= 14

### 安装 & 启动

```bash
# 1. 克隆仓库
git clone https://github.com/2060861791/文件共享服务器.git
cd 文件共享服务器

# 2. 安装依赖
npm install

# 3. 放入你要共享的文件
mkdir file
cp /你的文件/* file/

# 4. 启动服务器
node index.js
```

启动后，终端会显示服务器地址和二维码。手机连接同一 Wi-Fi，扫描二维码即可访问。

### Windows 双击启动

双击 `start.cmd`，自动检查环境并启动服务器。

### 开机自启（Windows）

1. 找到项目的 `start_hidden.vbs`
2. `Win + R` → 输入 `shell:startup` → 回车
3. 右键 → 新建快捷方式 → 指向 `start_hidden.vbs`
4. 下次开机自动后台启动，零窗口零打扰

或直接在 PowerShell 中运行：

```powershell
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut(
  [Environment]::GetFolderPath('Startup') + '\文件共享服务器.lnk'
)
$Shortcut.TargetPath = 'C:\你的路径\start_hidden.vbs'
$Shortcut.WorkingDirectory = 'C:\你的路径'
$Shortcut.Save()
```

取消自启：删除 `shell:startup` 中的 `文件共享服务器.lnk` 即可。

## ⚙️ 配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PORT` | `8420` | 服务器端口 |

```bash
# 自定义端口
set PORT=3000 && node index.js
```

文件存放目录：项目根目录下的 `file/` 文件夹。把你的文件、文件夹放进去即可自动展示。

## 📁 项目结构

```
文件共享服务器/
├── index.js              # 主程序（单文件）
├── start.cmd             # Windows 双击启动
├── start_hidden.vbs      # 开机自启隐藏启动脚本
├── package.json          # 依赖配置
├── .gitignore
├── README.md
└── file/                 # 文件存放目录（gitignore）
    ├── 你的文件夹/
    └── 你的文件.txt
```

## 🛠️ 技术栈

- **后端**：Node.js 原生 `http` 模块，无框架
- **前端**：服务端渲染 HTML，内联 CSS/JS，零外部请求
- **终端**：chalk + boxen + ora + qrcode-terminal
- **视频**：HTTP 206 Range 请求支持

## 📄 License

MIT © Levi

---

<p align="center">Made with ❤️ by Levi</p>
