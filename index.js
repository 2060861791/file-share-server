const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Terminal niceties ──────────────────────────────────────────
const chalk = require('chalk');
const boxen = require('boxen');
const ora = require('ora');
const symbols = require('log-symbols');
const qrcode = require('qrcode-terminal');

// ── Configuration ──────────────────────────────────────────────
const PORT = process.env.PORT || 8420;
const SERVE_ROOT = path.join(__dirname, 'file');
const PAGE_TITLE = '文件共享';

// ── MIME map ───────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',      '.htm': 'text/html',
  '.css': 'text/css',        '.js': 'application/javascript',
  '.json': 'application/json','.xml': 'application/xml',
  '.txt': 'text/plain',      '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',       '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',     '.gif': 'image/gif',
  '.svg': 'image/svg+xml',   '.ico': 'image/x-icon',
  '.webp': 'image/webp',     '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',       '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',      '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',       '.m4a': 'audio/mp4',
  '.zip': 'application/zip', '.rar': 'application/x-rar-compressed',
  '.7z': 'application/x-7z-compressed','.tar': 'application/x-tar',
  '.gz': 'application/gzip', '.apk': 'application/vnd.android.package-archive',
  '.doc': 'application/msword','.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel','.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint','.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const FILE_ICON = {
  image: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#58A6FF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  video: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F0883E" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
  audio: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#A371F7" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  pdf:   '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#F85149" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  archive:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8B949E" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>',
  code:  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7EE787" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  doc:   '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#58A6FF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  generic:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8B949E" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>',
  folder:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#D2A87A" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  up:    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8B949E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
};

// ── Network helpers ────────────────────────────────────────────
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({ name, ip: iface.address });
      }
    }
  }

  // Sort: prefer real physical adapters, push virtual/VPN to the end
  const PHYSICAL = /wi-?fi|wlan|en\d|eth\d|以太网|ethernet|无线|本地连接/i;
  const VIRTUAL = /virtual|vmware|virtualbox|vpn|tunnel|loopback|pseudo|docker|wsl|hyper-v|bluetooth|usb/i;

  const sorted = [...ips].sort((a, b) => {
    const aPhys = PHYSICAL.test(a.name);
    const bPhys = PHYSICAL.test(b.name);
    const aVirt = VIRTUAL.test(a.name);
    const bVirt = VIRTUAL.test(b.name);

    // Physical + not virtual = best
    const aScore = (aPhys ? 2 : 0) - (aVirt ? 1 : 0);
    const bScore = (bPhys ? 2 : 0) - (bVirt ? 1 : 0);
    return bScore - aScore;
  });

  const primary = sorted[0]?.ip || ips[0]?.ip || null;

  // Build debug info: show ALL found IPs so users can pick manually
  const allIPs = ips.map(i => i.ip);
  const uniqueIPs = [...new Set(allIPs)];

  return { ips, sorted, primary, uniqueIPs };
}

function guessInterfaceName(ipInfo) {
  const { ips, primary } = ipInfo;
  if (!primary) return '';
  if (ips.length <= 1) return '';
  const match = ips.find(i => i.ip === primary);
  return match ? ` (${match.name})` : '';
}

// ── Icon picker ────────────────────────────────────────────────
function iconFor(filename, isDir) {
  if (isDir) return FILE_ICON.folder;
  const ext = path.extname(filename).toLowerCase();
  if (/\.(png|jpg|jpeg|gif|svg|webp|bmp|ico)$/i.test(filename)) return FILE_ICON.image;
  if (/\.(mp4|webm|mkv|avi|mov)$/i.test(filename)) return FILE_ICON.video;
  if (/\.(mp3|wav|ogg|m4a|flac)$/i.test(filename)) return FILE_ICON.audio;
  if (ext === '.pdf') return FILE_ICON.pdf;
  if (/\.(zip|rar|7z|tar|gz)$/i.test(filename)) return FILE_ICON.archive;
  if (/\.(js|ts|py|go|rs|java|c|cpp|h|rb|php|swift|sh|bash|ps1|bat|cmd)$/i.test(filename)) return FILE_ICON.code;
  if (/\.(html|css|xml|json|md|yml|yaml|toml)$/i.test(filename)) return FILE_ICON.code;
  if (/\.(doc|docx|xls|xlsx|ppt|pptx)$/i.test(filename)) return FILE_ICON.doc;
  return FILE_ICON.generic;
}

// ── Human file size ────────────────────────────────────────────
function humanSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

// ── URL-encode path segments (keep slashes) ────────────────────
function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

// ── Build directory HTML ───────────────────────────────────────
function renderDir(dirPath, relPath, ip, port) {
  const baseUrl = `http://${ip}:${port}/`;
  const entries = [];
  try {
    const list = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const d of list) entries.push({
      name: d.name,
      isDir: d.isDirectory(),
      size: d.isFile() ? fs.statSync(path.join(dirPath, d.name)).size : 0,
      mtime: fs.statSync(path.join(dirPath, d.name)).mtime,
    });
  } catch (_) {
    return renderError(403, '无法读取目录');
  }

  // Sort: dirs first, then alphabetical
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
  });

  const breadcrumb = relPath ? relPath.split('/').filter(Boolean) : [];
  const hasParent = relPath !== '';

  const itemsHTML = entries.map(e => {
    const href = encodePath(e.isDir
      ? `/${relPath}${relPath ? '/' : ''}${e.name}/`
      : `/${relPath}${relPath ? '/' : ''}${e.name}`);
    const icon = iconFor(e.name, e.isDir);
    const sizeStr = e.isDir ? '—' : humanSize(e.size);
    const timeStr = e.mtime.toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
    return `
      <a class="file-row" href="${href}"${e.isDir ? '' : ' download'}>
        <span class="file-icon">${icon}</span>
        <span class="file-name">${escapeHTML(e.name)}</span>
        <span class="file-meta">
          <span class="file-size">${sizeStr}</span>
          <span class="file-time">${timeStr}</span>
        </span>
      </a>`;
  }).join('');

  const parentParts = breadcrumb.slice(0, -1);
  const parentHref = parentParts.length > 0 ? `/${parentParts.join('/')}/` : '/';
  const parentRow = hasParent ? `
    <a class="file-row file-row-up" href="${parentHref}">
      <span class="file-icon">${FILE_ICON.up}</span>
      <span class="file-name" style="color:var(--ink-secondary)">上级目录</span>
      <span class="file-meta"></span>
    </a>` : '';

  const bcHTML = breadcrumb.length > 0 ? `
    <nav class="breadcrumb">
      <a href="/">🏠 根目录</a>
      ${breadcrumb.map((seg, i) => {
        const link = '/' + breadcrumb.slice(0, i + 1).join('/') + '/';
        return `<span class="bc-sep">/</span><a href="${link}">${escapeHTML(decodeURIComponent(seg))}</a>`;
      }).join('')}
    </nav>` : '';

  const itemCount = entries.filter(e => !e.isDir).length;
  const dirCount = entries.filter(e => e.isDir).length;

  return layout(`
    <div class="status-bar">
      <span class="status-indicator"></span>
      <span class="status-text">服务运行中</span>
      <span class="status-hint">手机可访问</span>
    </div>

    <div class="wifi-hint">
      📡 请确保手机和电脑连接同一个 Wi-Fi
    </div>

    <div class="header">
      <span class="header-title">📂 文件共享</span>
      <span class="header-meta">${itemCount + dirCount} 个项目 · ${dirCount} 个文件夹, ${itemCount} 个文件</span>
    </div>

    ${bcHTML}

    <div class="file-list">
      ${parentRow}
      ${itemsHTML}
    </div>

    ${entries.length === 0 && !hasParent ? `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--ink-secondary)" stroke-width="1.2" style="opacity:0.5">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <p>文件夹为空</p>
        <span>将文件放入 <code>file/</code> 目录即可在此显示</span>
      </div>
    ` : ''}
  `, ip, port, relPath);
}

function renderError(code, msg) {
  const emoji = { 403: '🚫', 404: '🔮', 500: '💥' };
  return layout(`
    <div class="error-state">
      <span style="font-size:56px">${emoji[code] || '❓'}</span>
      <h2>${code}</h2>
      <p>${escapeHTML(msg)}</p>
      <a href="/" class="back-link">← 返回根目录</a>
    </div>
  `, '0.0.0.0', PORT, '');
}

// ── Page layout shell ──────────────────────────────────────────
function layout(bodyHTML, ip, port, currentPath) {
  const baseUrl = `http://${ip}:${port}/`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0D1117">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>${PAGE_TITLE}</title>
<style>
  /* ── Reset & tokens ──────────────────────── */
  :root {
    --bg: #0D1117;
    --surface: #161B22;
    --surface-hover: #1C2128;
    --border: #30363D;
    --ink: #E6EDF3;
    --ink-secondary: #8B949E;
    --ink-muted: #484F58;
    --accent: #D2A87A;
    --accent-bright: #E3B98C;
    --danger: #F85149;
    --safe: #3FB950;
    --file-blue: #58A6FF;
    --radius: 10px;
    --radius-sm: 6px;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif;
    font-size: 15px;
    line-height: 1.5;
    color: var(--ink);
    background: var(--bg);
    -webkit-font-smoothing: antialiased;
  }
  body {
    min-height: 100dvh;
    padding: 16px;
    padding-bottom: env(safe-area-inset-bottom, 24px);
    max-width: 720px;
    margin: 0 auto;
  }

  /* ── Status bar ───────────────────────────── */
  .status-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 16px;
    margin-bottom: 12px;
  }
  .status-indicator {
    width: 10px; height: 10px;
    border-radius: 50%;
    background: var(--safe);
    box-shadow: 0 0 8px var(--safe);
    flex-shrink: 0;
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  .status-text {
    font-size: 14px;
    font-weight: 600;
    color: var(--ink);
  }
  .status-hint {
    margin-left: auto;
    font-size: 12px;
    color: var(--ink-muted);
  }

  /* ── Wi-Fi hint ────────────────────────────── */
  .wifi-hint {
    text-align: center;
    padding: 12px 16px;
    margin-bottom: 16px;
    background: rgba(210, 168, 122, 0.08);
    border: 1px solid rgba(210, 168, 122, 0.2);
    border-radius: var(--radius-sm);
    font-size: 13px;
    color: var(--accent-bright);
  }

  /* ── Header ────────────────────────────────── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 12px;
    padding: 0 2px;
  }
  .header-title {
    font-size: 16px;
    font-weight: 700;
    color: var(--ink);
  }
  .header-meta {
    font-size: 12px;
    color: var(--ink-muted);
  }

  /* ── Breadcrumb ──────────────────────────── */
  .breadcrumb {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 12px;
    padding: 8px 12px;
    background: var(--surface);
    border-radius: var(--radius-sm);
    font-size: 13px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .breadcrumb a {
    color: var(--ink-secondary);
    text-decoration: none;
    white-space: nowrap;
    padding: 2px 4px;
    border-radius: 4px;
    transition: color 0.15s, background 0.15s;
  }
  .breadcrumb a:hover, .breadcrumb a:active { color: var(--ink); background: var(--surface-hover); }
  .breadcrumb a:last-child { color: var(--ink); font-weight: 600; }
  .bc-sep { color: var(--ink-muted); font-size: 11px; user-select: none; }

  /* ── File list ───────────────────────────── */
  .file-list {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .file-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 11px 14px;
    text-decoration: none;
    color: var(--ink);
    border-bottom: 1px solid var(--border);
    transition: background 0.12s;
    -webkit-tap-highlight-color: transparent;
    min-height: 48px; /* tap target */
  }
  .file-row:last-child { border-bottom: none; }
  .file-row:active, .file-row:hover { background: var(--surface-hover); }
  .file-row-up { border-bottom: 1px solid var(--border); }

  .file-icon {
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255,255,255,0.03);
    border-radius: 8px;
  }
  .file-name {
    flex: 1;
    min-width: 0;
    font-size: 14px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1.3;
  }
  .file-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;
    flex-shrink: 0;
    margin-left: auto;
  }
  .file-size {
    font-size: 12px;
    color: var(--ink-secondary);
    font-variant-numeric: tabular-nums;
    font-family: "SF Mono", "Cascadia Code", "Fira Code", monospace;
  }
  .file-time {
    font-size: 10px;
    color: var(--ink-muted);
  }

  /* ── Empty & Error ───────────────────────── */
  .empty-state, .error-state {
    text-align: center;
    padding: 64px 24px;
    color: var(--ink-secondary);
  }
  .empty-state p { font-size: 16px; margin: 12px 0 6px; color: var(--ink); }
  .empty-state span { font-size: 13px; }
  .empty-state code {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 12px;
    color: var(--accent);
  }
  .error-state h2 { font-size: 28px; color: var(--ink); margin: 8px 0; }
  .back-link {
    display: inline-block;
    margin-top: 16px;
    color: var(--accent);
    text-decoration: none;
    font-weight: 500;
    font-size: 14px;
  }

  /* ── Footer ──────────────────────────────── */
  .footer {
    text-align: center;
    margin-top: 28px;
    padding: 12px 0 8px;
    font-size: 11px;
    color: var(--ink-muted);
    border-top: 1px solid var(--border);
  }

  /* ── Toast ───────────────────────────────── */
  .toast {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%) translateY(80px);
    background: var(--safe);
    color: #0D1117;
    padding: 10px 20px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 600;
    pointer-events: none;
    opacity: 0;
    transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.2s;
    z-index: 100;
    font-family: inherit;
  }
  .toast.show { transform: translateX(-50%) translateY(0); opacity: 1; }

  /* ── Reduced motion ──────────────────────── */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
</style>
</head>
<body>
${bodyHTML}
<div class="toast" id="toast"></div>
<footer class="footer">
  Made with ❤️ by Levi
</footer>
<script>
  let toastTimer;
  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
  }
</script>
</body>
</html>`;
}

function escapeHTML(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Request handler ────────────────────────────────────────────
function handleRequest(req, res) {
  // Decode URL path
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  // Normalize: strip trailing slash for files, keep for dir listing
  const isDirReq = urlPath.endsWith('/');
  const normalized = urlPath.replace(/\/+$/, '');
  const relPath = normalized.replace(/^\//, '');
  const diskPath = path.join(SERVE_ROOT, relPath);

  // Security: prevent traversal outside SERVE_ROOT
  const resolved = path.resolve(diskPath);
  if (!resolved.startsWith(SERVE_ROOT)) {
    res.writeHead(403);
    res.end(renderError(403, '禁止访问'));
    return;
  }

  // Check what's on disk
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    res.writeHead(404);
    res.end(renderError(404, '文件未找到'));
    return;
  }

  // If it's a directory, serve the HTML listing
  if (stat.isDirectory()) {
    // Redirect "/dir" to "/dir/" so relative links work
    if (!isDirReq && req.url !== '/') {
      res.writeHead(301, { Location: req.url + '/' });
      res.end();
      return;
    }
    const html = renderDir(resolved, relPath, ipInfo.primary || 'localhost', PORT);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // It's a file — serve it
  const ext = path.extname(resolved).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const totalSize = stat.size;

  // Range request support (for video seeking)
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mime,
    });
    const stream = fs.createReadStream(resolved, { start, end });
    stream.pipe(res);
    stream.on('error', () => { res.end(); });
    return;
  }

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': totalSize,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  });
  const stream = fs.createReadStream(resolved);
  stream.pipe(res);
  stream.on('error', () => { res.end(); });
}

// ── Start server ───────────────────────────────────────────────
const spinner = ora({
  text: chalk.gray('正在扫描网络接口...'),
  color: 'yellow',
}).start();

const ipInfo = getLocalIPs();

setTimeout(() => {
  const ifName = guessInterfaceName(ipInfo);

  // ── Handle the case where NO valid IP is found ──────────────────
  if (!ipInfo.primary) {
    spinner.fail(chalk.red('未找到有效的局域网 IP 地址'));
    console.log('');
    console.log(chalk.yellow('  ⚠ 可能原因：'));
    console.log(chalk.gray('    1. 电脑未连接到任何网络（Wi-Fi 或以太网）'));
    console.log(chalk.gray('    2. 防火墙或安全软件阻止了网络检测'));
    console.log(chalk.gray('    3. 所有网络接口都被识别为虚拟/内部接口'));
    console.log('');
    if (ipInfo.uniqueIPs.length > 0) {
      console.log(chalk.yellow('  📋 检测到的 IP 地址（可能被过滤）：'));
      for (const ip of ipInfo.uniqueIPs) {
        console.log(chalk.gray(`    - ${ip}`));
      }
      console.log(chalk.white(`  你可以手动用浏览器访问: http://<你的IP>:${PORT}/`));
    } else {
      console.log(chalk.white(`  如果你知道本机 IP，可以用浏览器访问: http://<你的IP>:${PORT}/`));
    }
    console.log('');

    // Still serve — user can access via localhost on the PC itself
    const fallbackAddr = `http://localhost:${PORT}/`;
    console.log(chalk.green(`  ✓ 服务器已在 http://localhost:${PORT}/ 启动（仅本机可用）`));
    console.log(chalk.gray('  ') + symbols.info + ' ' + chalk.dim('按 Ctrl+C 停止服务器'));
    console.log('');
    return;
  }

  const addr = `http://${ipInfo.primary}:${PORT}/`;

  spinner.succeed(chalk.green('网络就绪'));

  // ---- Build info box (left panel) ----
  const boxContent = [
    chalk.bold.hex('#E3B98C')('📡 地址  ') + chalk.hex('#D2A87A')(addr),
    chalk.bold.hex('#8B949E')('🔌 端口  ') + chalk.white(String(PORT)),
    chalk.bold.hex('#8B949E')('🌐 网卡  ') + chalk.white(ipInfo.primary + (ifName || '')),
    chalk.bold.hex('#8B949E')('📂 目录  ') + chalk.white(SERVE_ROOT),
  ];

  // Show ALL unique IPs so user can manually pick if the auto-selected one is wrong
  if (ipInfo.uniqueIPs.length > 1) {
    boxContent.push(chalk.bold.hex('#8B949E')('📋 所有 IP ') + chalk.white(ipInfo.uniqueIPs.join(', ')));
  }

  const infoBox = boxen(boxContent.join('\n'), {
    padding: { top: 0, right: 2, bottom: 0, left: 2 },
    margin: 0,
    borderStyle: 'round',
    borderColor: '#30363D',
    backgroundColor: '#161B22',
    title: chalk.bold.hex('#E3B98C')('📡 文件共享服务器'),
    titleAlignment: 'center',
    float: 'left',
  });

  // ---- Generate QR code, then print side by side ----
  qrcode.generate(addr, { small: true }, (qrString) => {
    // Split and drop trailing blank line from qrcode-terminal
    const qrLines = qrString.split('\n').filter((l, i, arr) => i < arr.length - 1 || l.trim() !== '');
    const QR_WIDTH = 27; // small QR is always 27 columns

    // QR block: centered label + QR lines
    const qrLabel = chalk.hex('#8B949E')('手机扫码访问');
    const labelPad = Math.floor((QR_WIDTH - visualWidth(qrLabel)) / 2);
    const qrBlock = [
      ' '.repeat(Math.max(0, labelPad)) + qrLabel,
      ...qrLines.map(l => chalk.hex('#D2A87A')(l)),
    ];

    const infoLines = infoBox.split('\n');
    const boxWidth = Math.max(...infoLines.map(visualWidth));

    // Match heights — pad shorter block with blank lines
    const maxH = Math.max(infoLines.length, qrBlock.length);
    while (infoLines.length < maxH) infoLines.push('');
    while (qrBlock.length < maxH) qrBlock.push('');

    const GAP = 3;

    // Print side by side
    console.log('');
    for (let i = 0; i < maxH; i++) {
      const left = infoLines[i] || '';
      const right = qrBlock[i] || '';
      const leftPad = boxWidth - visualWidth(left);
      const rightPad = QR_WIDTH - visualWidth(right);
      console.log(left + ' '.repeat(Math.max(0, leftPad + GAP)) + right + ' '.repeat(Math.max(0, rightPad)));
    }

    // Quick tips
    console.log('');
    console.log(chalk.gray('  ') + symbols.info + ' ' + chalk.white('手机连接同一 WiFi 后，在浏览器打开上方地址即可'));
    console.log(chalk.gray('  ') + symbols.info + ' ' + chalk.dim('按 Ctrl+C 停止服务器'));
    console.log('');
  });
}, 400);

// ── strip ANSI helper (for measuring visual width) ────────────
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

function visualWidth(str) {
  const plain = stripAnsi(str);
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    // CJK, full-width forms, emoji — treat as width 2
    if ((cp >= 0x1100 && cp <= 0x115F) ||   // Hangul Jamo
        (cp >= 0x2E80 && cp <= 0xA4CF) ||   // CJK Radicals through Yi
        (cp >= 0xAC00 && cp <= 0xD7A3) ||   // Hangul Syllables
        (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK Compatibility
        (cp >= 0xFE10 && cp <= 0xFE19) ||   // Vertical forms
        (cp >= 0xFE30 && cp <= 0xFE6F) ||   // CJK Compatibility Forms
        (cp >= 0xFF00 && cp <= 0xFF60) ||   // Fullwidth Forms
        (cp >= 0xFFE0 && cp <= 0xFFE6) ||   // Fullwidth Signs
        (cp >= 0x1F300 && cp <= 0x1F9FF) || // Misc Symbols, Emoji
        (cp >= 0x20000 && cp <= 0x2FFFD) || // CJK Ext B+
        (cp >= 0x30000 && cp <= 0x3FFFD)) { // CJK Ext G+
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

const server = http.createServer(handleRequest);

server.listen(PORT, '0.0.0.0', () => {
  // Server is listening — spinner & box are handled above
});

server.on('error', (err) => {
  spinner.stop();
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ${symbols.error}  ${chalk.red(`端口 ${PORT} 已被占用`)}`);
    console.error(`  ${chalk.gray('尝试：')} ${chalk.yellow(`set PORT=8421 && node index.js`)}\n`);
  } else {
    console.error(`\n  ${symbols.error}  ${chalk.red(`启动失败：${err.message}`)}\n`);
  }
  process.exit(1);
});
