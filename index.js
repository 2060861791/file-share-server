const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Transform, pipeline } = require('stream');
const Busboy = require('busboy');

// ── Terminal niceties ──────────────────────────────────────────
const chalk = require('chalk');
const boxen = require('boxen');
const ora = require('ora');
const symbols = require('log-symbols');
const qrcode = require('qrcode-terminal');

// ── .env loader (no dependency) ────────────────────────────────
// Reads .env next to this file if present. Real env vars always win.
(function loadDotEnv() {
  let text;
  try {
    text = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  } catch {
    return; // no .env — fine
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes: SHARE_DIR="/srv/file share/files"
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
})();

// ── Configuration ──────────────────────────────────────────────
const PORT = process.env.PORT || 8420;
// Shared data lives OUTSIDE the project, so `git pull` never touches user files.
const SERVE_ROOT = process.env.SHARE_DIR || '/srv/file-share/files';
const ROOT = path.resolve(SERVE_ROOT);
const PAGE_TITLE = '文件共享';
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 0; // 0 = 无限制

// ── Shared folder must exist before we serve anything ──────────
(function ensureRoot() {
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    // Fail at startup rather than on the first upload.
    fs.accessSync(ROOT, fs.constants.R_OK | fs.constants.W_OK);
  } catch (err) {
    console.error('');
    console.error(`  ${symbols.error}  ${chalk.red('共享目录不可用')} ${chalk.white(ROOT)}`);
    console.error(`  ${chalk.gray(err.code + ': ' + err.message)}`);
    console.error('');
    console.error(chalk.yellow('  请通过环境变量指定一个有写权限的目录：'));
    console.error(chalk.gray('    Linux  : ') + chalk.white('SHARE_DIR=/srv/file-share/files node index.js'));
    console.error(chalk.gray('    Windows: ') + chalk.white('set SHARE_DIR=D:\\file-share\\files && node index.js'));
    console.error(chalk.gray('    或复制 ') + chalk.white('.env.example') + chalk.gray(' 为 ') + chalk.white('.env') + chalk.gray(' 并修改 SHARE_DIR'));
    console.error('');
    console.error(chalk.gray('  注意：不要回退到项目目录存放共享文件，否则 git pull 会影响用户数据。'));
    console.error('');
    process.exit(1);
  }
})();

// ── Traffic accounting (whole server, all clients) ─────────────
// Counters are cumulative byte totals; speed is derived once per second.
const traffic = {
  uploadBytes: 0,
  downloadBytes: 0,
  activeUploads: 0,
  activeDownloads: 0,
};

const speed = { upload: 0, download: 0 };
let lastSample = { bytes: 0, bytesDown: 0, at: Date.now() };

setInterval(() => {
  const now = Date.now();
  const seconds = (now - lastSample.at) / 1000;
  if (seconds <= 0) return;
  speed.upload = Math.max(0, Math.round((traffic.uploadBytes - lastSample.bytes) / seconds));
  speed.download = Math.max(0, Math.round((traffic.downloadBytes - lastSample.bytesDown) / seconds));
  lastSample = { bytes: traffic.uploadBytes, bytesDown: traffic.downloadBytes, at: now };
}, 1000).unref();

// Counts bytes that actually pass through, not bytes read off disk.
function meterStream(counter, onBytes) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      traffic[counter] += chunk.length;
      if (onBytes) onBytes(chunk.length);
      callback(null, chunk);
    },
  });
}

// ── Path safety ────────────────────────────────────────────────
// NOTE: a naive `resolved.startsWith(ROOT)` is wrong — it would also accept
// "/srv/file-share/files-evil". Require an exact match or a real separator.
function safeResolve(relative) {
  const target = path.resolve(ROOT, relative || '');
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null;
  return target;
}

// Turn any user-supplied label into a single safe path segment.
function safeName(raw) {
  let name = String(raw == null ? '' : raw);
  name = name.split(/[\\/]/).pop() || '';        // drop any directory part (both separators, any OS)
  name = name.replace(/[\x00-\x1f\x7f]/g, '');   // control chars & NUL
  name = name.trim();
  if (name === '.' || name === '..') name = '';  // never a directory reference
  if (!name) name = 'unnamed';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) name = '_' + name; // Windows reserved
  if (Buffer.byteLength(name) > 200) {           // keep the extension, trim the stem
    const ext = path.extname(name).slice(0, 20);
    name = Buffer.from(name).subarray(0, 200 - Buffer.byteLength(ext)).toString('utf8').replace(/\uFFFD$/, '') + ext;
  }
  return name;
}

// "test.zip" -> "test (1).zip" -> "test (2).zip"
function withSuffix(name, n) {
  const ext = path.extname(name);
  return `${path.basename(name, ext)} (${n})${ext}`;
}

// Create a new file without ever overwriting. 'wx' is atomic, so two clients
// uploading "test.zip" at the same moment can't both win.
function createUniqueFile(dir, name) {
  for (let attempt = 0; attempt <= 9999; attempt++) {
    const candidate = attempt === 0 ? name : withSuffix(name, attempt);
    try {
      const fd = fs.openSync(path.join(dir, candidate), 'wx');
      return { stream: fs.createWriteStream(null, { fd }), finalName: candidate };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('同名文件过多');
}

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

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

// ── Live throughput panel ──────────────────────────────────────
// Values are the whole server's — every client's transfers added together,
// not just the browser looking at this page.
function renderTraffic() {
  return `
    <section class="traffic" aria-label="服务器实时速度">
      <div class="traffic-grid">
        <div class="traffic-cell">
          <span class="traffic-label"><span class="arrow-up">▲</span> 上传速度</span>
          <span class="traffic-value num" id="stat-upload">0 B/s</span>
        </div>
        <div class="traffic-cell">
          <span class="traffic-label"><span class="arrow-down">▼</span> 下载速度</span>
          <span class="traffic-value num" id="stat-download">0 B/s</span>
        </div>
        <div class="traffic-cell">
          <span class="traffic-label">活动上传</span>
          <span class="traffic-value num" id="stat-active-upload">0</span>
        </div>
        <div class="traffic-cell">
          <span class="traffic-label">活动下载</span>
          <span class="traffic-value num" id="stat-active-download">0</span>
        </div>
      </div>
      <svg class="duplex" id="duplex" viewBox="0 0 300 40" preserveAspectRatio="none" aria-hidden="true">
        <line class="duplex-axis" x1="0" y1="20" x2="300" y2="20" />
        <polyline class="duplex-line duplex-up" id="duplex-up" points="" />
        <polyline class="duplex-line duplex-down" id="duplex-down" points="" />
      </svg>
      <div class="duplex-caption">
        <span>近 60 秒 · 所有用户合计</span>
        <span><span class="arrow-up">▲</span> 上传&nbsp;&nbsp;<span class="arrow-down">▼</span> 下载</span>
      </div>
    </section>`;
}

// ── Upload panel (uploads land in the directory being viewed) ──
function renderUpload(relPath) {
  const here = '/' + (relPath ? relPath + '/' : '');
  return `
    <section class="upload-panel">
      <div class="drop-zone" id="drop-zone">
        <div class="drop-row">
          <div class="drop-text">
            <span class="drop-title">拖拽文件到这里上传</span>
            <span class="drop-sub">保存到 <code>${escapeHTML(here)}</code></span>
          </div>
          <div class="drop-actions">
            <button type="button" class="btn" id="pick-btn">选择文件</button>
            <button type="button" class="btn btn-primary" id="upload-btn" disabled>上传</button>
          </div>
        </div>
        <input type="file" id="file-input" multiple hidden>
      </div>
      <div class="upload-list" id="upload-list"></div>
    </section>`;
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
        const link = encodePath('/' + breadcrumb.slice(0, i + 1).join('/')) + '/';
        return `<span class="bc-sep">/</span><a href="${link}">${escapeHTML(seg)}</a>`;
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

    ${renderTraffic()}

    <div class="wifi-hint">
      📡 请确保手机和电脑连接同一个 Wi-Fi
    </div>

    <div class="header">
      <span class="header-title">📂 文件共享</span>
      <span class="header-meta">${itemCount + dirCount} 个项目 · ${dirCount} 个文件夹, ${itemCount} 个文件</span>
    </div>

    ${bcHTML}

    ${renderUpload(relPath)}

    <div class="file-list">
      ${parentRow}
      ${itemsHTML}
    </div>

    ${entries.length === 0 && !hasParent ? `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--ink-secondary)" stroke-width="1.2" style="opacity:0.5">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <p>还没有文件</p>
        <span>拖拽文件到上面的区域，或者点「选择文件」上传</span>
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

  /* ── Traffic (whole-server throughput) ─────── */
  .traffic {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 14px 8px;
    margin-bottom: 12px;
  }
  .traffic-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    margin-bottom: 10px;
  }
  .traffic-cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .traffic-label {
    font-size: 11px;
    color: var(--ink-muted);
    letter-spacing: 0.02em;
    white-space: nowrap;
  }
  .traffic-value {
    font-size: 15px;
    font-weight: 600;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .arrow-up { color: var(--accent); font-size: 9px; }
  .arrow-down { color: var(--file-blue); font-size: 9px; }
  .num {
    font-family: "SF Mono", "Cascadia Code", "Fira Code", monospace;
    font-variant-numeric: tabular-nums;
  }

  /* Mirrored 60s trace: upload above the axis, download below.
     One shared time axis makes the two directions comparable at a glance. */
  .duplex {
    display: block;
    width: 100%;
    height: 40px;
    overflow: visible;
  }
  .duplex-axis { stroke: var(--border); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .duplex-line { fill: none; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .duplex-up { stroke: var(--accent); }
  .duplex-down { stroke: var(--file-blue); }
  .duplex-caption {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: var(--ink-muted);
    margin-top: 2px;
  }

  /* ── Upload ────────────────────────────────── */
  .upload-panel { margin-bottom: 12px; }
  .drop-zone {
    background: var(--surface);
    border: 1px dashed var(--border);
    border-radius: var(--radius);
    padding: 14px;
    transition: border-color 0.15s, background 0.15s;
  }
  .drop-zone.is-over {
    border-color: var(--accent);
    background: rgba(210, 168, 122, 0.07);
  }
  .drop-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .drop-text { flex: 1; min-width: 150px; }
  .drop-title { display: block; font-size: 13px; font-weight: 600; color: var(--ink); }
  .drop-sub { display: block; font-size: 11px; color: var(--ink-muted); margin-top: 2px; }
  .drop-sub code {
    font-family: "SF Mono", "Cascadia Code", "Fira Code", monospace;
    color: var(--accent);
  }
  .drop-actions { display: flex; gap: 8px; flex-shrink: 0; }
  .btn {
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    padding: 8px 14px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface-hover);
    color: var(--ink);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, opacity 0.15s;
    -webkit-tap-highlight-color: transparent;
  }
  .btn:hover:not(:disabled) { border-color: var(--ink-muted); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #0D1117;
  }
  .btn-primary:hover:not(:disabled) { background: var(--accent-bright); border-color: var(--accent-bright); }
  .btn:focus-visible, .drop-zone:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* Per-file progress rows */
  .upload-list { margin-top: 8px; }
  .up-row {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    margin-bottom: 6px;
  }
  .up-top {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 6px;
  }
  .up-name {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .up-status { font-size: 12px; color: var(--ink-secondary); flex-shrink: 0; }
  .up-row.is-done .up-status { color: var(--safe); }
  .up-row.is-error .up-status { color: var(--danger); }
  /* A deliberate cancel isn't a failure — keep it quiet. */
  .up-row.is-cancelled .up-status { color: var(--ink-muted); }
  .up-cancel {
    font-family: inherit;
    font-size: 11px;
    background: none;
    border: none;
    color: var(--ink-muted);
    cursor: pointer;
    padding: 0 2px;
    flex-shrink: 0;
  }
  .up-cancel:hover { color: var(--danger); }
  .up-cancel:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .up-bar {
    height: 4px;
    background: var(--surface-hover);
    border-radius: 2px;
    overflow: hidden;
  }
  .up-fill {
    height: 100%;
    width: 0;
    background: var(--accent);
    border-radius: 2px;
    transition: width 0.2s linear;
  }
  .up-row.is-done .up-fill { background: var(--safe); }
  .up-row.is-error .up-fill { background: var(--danger); }
  .up-row.is-cancelled .up-fill { background: var(--ink-muted); }
  .up-meta {
    display: flex;
    gap: 10px;
    margin-top: 5px;
    font-size: 11px;
    color: var(--ink-muted);
  }
  .up-meta:empty { display: none; }

  @media (max-width: 520px) {
    .traffic-grid { grid-template-columns: 1fr 1fr; }
    .drop-actions { width: 100%; }
    .drop-actions .btn { flex: 1; }
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
  const CURRENT_DIR = ${JSON.stringify(currentPath)};

  let toastTimer;
  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
  }

  function formatSpeed(bps) {
    if (!bps || bps < 1) return '0 B/s';
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let i = 0, v = bps;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
  }
  function formatBytes(b) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = b;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + ' ' + units[i];
  }
  function formatDuration(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '';
    if (seconds < 60) return Math.ceil(seconds) + ' 秒';
    const m = Math.floor(seconds / 60);
    if (m < 60) return m + ' 分 ' + Math.ceil(seconds % 60) + ' 秒';
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
  }

  /* ── Whole-server speed, refreshed once a second ────────────── */
  const HISTORY_LEN = 60;
  const history = [];

  function drawDuplex() {
    const upLine = document.getElementById('duplex-up');
    const downLine = document.getElementById('duplex-down');
    if (!upLine || !downLine) return;

    // Auto-range to the busiest second on screen, floored at 1 MB/s so an
    // idle link draws a flat line instead of amplifying rounding noise.
    let peak = 0;
    for (const h of history) peak = Math.max(peak, h.up, h.down);
    const scale = Math.max(peak, 1024 * 1024);
    const x = i => (i / (HISTORY_LEN - 1)) * 300;
    const offset = HISTORY_LEN - history.length;
    // pick() returns the signed pixel offset from the centre line
    const trace = pick => history
      .map((h, i) => x(i + offset).toFixed(1) + ',' + (20 + pick(h)).toFixed(1))
      .join(' ');

    upLine.setAttribute('points', trace(h => -Math.min(1, h.up / scale) * 18));
    downLine.setAttribute('points', trace(h => Math.min(1, h.down / scale) * 18));
  }

  async function pollStats() {
    if (document.hidden) return; // a hidden tab shouldn't keep the server busy
    try {
      const res = await fetch('/api/stats', { cache: 'no-store' });
      if (!res.ok) return;
      const s = await res.json();
      document.getElementById('stat-upload').textContent = formatSpeed(s.uploadSpeed);
      document.getElementById('stat-download').textContent = formatSpeed(s.downloadSpeed);
      document.getElementById('stat-active-upload').textContent = s.activeUploads;
      document.getElementById('stat-active-download').textContent = s.activeDownloads;

      history.push({ up: s.uploadSpeed, down: s.downloadSpeed });
      if (history.length > HISTORY_LEN) history.shift();
      drawDuplex();
    } catch (_) { /* server restarting — try again next tick */ }
  }
  setInterval(pollStats, 1000);
  pollStats();

  /* ── Upload ─────────────────────────────────────────────────
     One file per request, one request at a time. Sequential keeps
     per-file speed honest and avoids hammering the server's disk. */
  const fileInput = document.getElementById('file-input');
  const pickBtn = document.getElementById('pick-btn');
  const uploadBtn = document.getElementById('upload-btn');
  const dropZone = document.getElementById('drop-zone');
  const list = document.getElementById('upload-list');

  const queue = [];
  let activeCount = 0;
  let succeeded = 0;
  let refreshing = false;

  function setStatus(item, state, text) {
    item.row.className = 'up-row is-' + state;
    item.row.querySelector('.up-status').textContent = text;
  }
  function setProgress(item, fraction) {
    item.row.querySelector('.up-fill').style.width = (fraction * 100).toFixed(1) + '%';
  }
  function setMeta(item, parts) {
    item.row.querySelector('.up-meta').textContent = parts.filter(Boolean).join(' · ');
  }

  function addFiles(files) {
    for (const file of files) {
      const row = document.createElement('div');
      row.className = 'up-row is-waiting';
      row.innerHTML =
        '<div class="up-top">' +
          '<span class="up-name"></span>' +
          '<span class="up-status">等待中</span>' +
          '<button type="button" class="up-cancel" aria-label="取消上传">✕</button>' +
        '</div>' +
        '<div class="up-bar"><div class="up-fill"></div></div>' +
        '<div class="up-meta"></div>';
      row.querySelector('.up-name').textContent = file.name;
      list.appendChild(row);

      const item = { file, row, xhr: null, started: false, cancelled: false, lastLoaded: 0, lastTime: 0 };
      const cancelBtn = row.querySelector('.up-cancel');
      cancelBtn.addEventListener('click', () => {
        if (item.xhr) { item.xhr.abort(); return; }
        item.cancelled = true;
        setStatus(item, 'cancelled', '已取消');
        pump();
      });
      queue.push(item);
    }
    uploadBtn.disabled = queue.every(i => i.started || i.cancelled);
  }

  function send(item) {
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    item.lastTime = Date.now();
    setStatus(item, 'active', '上传中');

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const fraction = e.loaded / e.total;
      setProgress(item, fraction);

      // Percentage is exact immediately; speed needs a window to be meaningful.
      const now = Date.now();
      const dt = (now - item.lastTime) / 1000;
      if (dt >= 0.4) {
        item.speed = (e.loaded - item.lastLoaded) / dt;
        item.lastLoaded = e.loaded;
        item.lastTime = now;
      }
      const eta = item.speed > 0 ? (e.total - e.loaded) / item.speed : Infinity;
      setMeta(item, [
        Math.floor(fraction * 100) + '%',
        item.speed ? formatSpeed(item.speed) : '',
        eta === Infinity ? '' : '还剩 ' + formatDuration(eta),
      ]);
    };

    xhr.onload = () => {
      activeCount--;
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch (_) {}

      const entry = data && data.files && data.files[0];
      if (entry && entry.ok) {
        succeeded++;
        setProgress(item, 1);
        setStatus(item, 'done', '✓ 上传完成');
        // Same name already existed? The server kept both — say so.
        setMeta(item, [
          formatBytes(entry.size),
          entry.savedAs !== entry.name ? '已保存为 ' + entry.savedAs : '',
        ]);
        const cancelBtn = item.row.querySelector('.up-cancel');
        if (cancelBtn) cancelBtn.remove();
      } else {
        setProgress(item, 1);
        setStatus(item, 'error', '✕ 上传失败');
        setMeta(item, [(entry && entry.error) || (data && data.error) || ('HTTP ' + xhr.status)]);
      }
      pump();
    };
    xhr.onerror = () => {
      activeCount--;
      setStatus(item, 'error', '✕ 上传失败');
      setMeta(item, ['网络错误，连接已中断']);
      pump();
    };
    xhr.onabort = () => {
      activeCount--;
      setStatus(item, 'cancelled', '已取消');
      setMeta(item, [formatBytes(item.lastLoaded) + ' 已传输']);
      pump();
    };

    const dir = CURRENT_DIR ? '?dir=' + encodeURIComponent(CURRENT_DIR) : '';
    xhr.open('POST', '/api/upload' + dir);
    const form = new FormData();
    form.append('file', item.file, item.file.name);
    xhr.send(form);
  }

  function pump() {
    if (activeCount > 0 || refreshing) return;

    const next = queue.find(i => !i.started && !i.cancelled);
    if (next) {
      next.started = true;
      activeCount++;
      send(next);
      return;
    }

    // Everything settled — reload so the new files show up in the list.
    if (succeeded > 0) {
      refreshing = true;
      showToast('✓ 已上传 ' + succeeded + ' 个文件 · 正在刷新列表');
      setTimeout(() => location.reload(), 1400);
    } else {
      uploadBtn.disabled = true;
    }
  }

  pickBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) addFiles(fileInput.files);
    fileInput.value = ''; // so picking the same file again still fires
  });
  uploadBtn.addEventListener('click', () => {
    uploadBtn.disabled = true;
    pump();
  });

  // Dropping anywhere on the page counts — the zone lights up as the target.
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dropZone.classList.add('is-over');
  });
  window.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
  });
  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) dropZone.classList.remove('is-over');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('is-over');
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
</script>
</body>
</html>`;
}

function escapeHTML(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Stream a file to the client, metering what really goes out ─
function serveFile(req, res, absPath, stat, range) {
  const ext = path.extname(absPath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const totalSize = stat.size;

  let start = 0;
  let end = totalSize - 1;
  let status = 200;
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const [, rawStart, rawEnd] = match;
      if (rawStart === '' && rawEnd === '') {
        res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
        res.end();
        return;
      }
      // "bytes=-500" means the last 500 bytes
      if (rawStart === '') {
        start = Math.max(0, totalSize - Number(rawEnd));
      } else {
        start = Number(rawStart);
        end = rawEnd === '' ? totalSize - 1 : Math.min(Number(rawEnd), totalSize - 1);
      }
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= totalSize) {
        res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
        res.end();
        return;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
    }
  }

  headers['Content-Length'] = end - start + 1;

  // A HEAD response has no body — don't count it as traffic.
  if (req.method === 'HEAD') {
    res.writeHead(status, headers);
    res.end();
    return;
  }

  res.writeHead(status, headers);

  traffic.activeDownloads++;
  const source = fs.createReadStream(absPath, { start, end });
  const meter = meterStream('downloadBytes');

  // pipeline() destroys the reader if the client goes away mid-download,
  // so an aborted transfer can't keep draining the disk into a dead socket.
  pipeline(source, meter, res, () => {
    traffic.activeDownloads--;
  });
}

// ── POST /api/upload ───────────────────────────────────────────
// Files stream straight to disk: nothing is ever buffered whole in RAM.
// Target directory comes from ?dir=<relative path inside the share>.
function handleUpload(req, res, query) {
  const targetDir = safeResolve(query.get('dir') || '');
  if (!targetDir) {
    sendJSON(res, 403, { ok: false, error: '目标目录不在共享范围内' });
    req.resume();
    return;
  }

  let dirStat;
  try {
    dirStat = fs.statSync(targetDir);
  } catch {
    sendJSON(res, 404, { ok: false, error: '目标目录不存在' });
    req.resume();
    return;
  }
  if (!dirStat.isDirectory()) {
    sendJSON(res, 400, { ok: false, error: '目标不是目录' });
    req.resume();
    return;
  }

  let busboy;
  try {
    busboy = Busboy({
      headers: req.headers,
      limits: MAX_UPLOAD_BYTES ? { fileSize: MAX_UPLOAD_BYTES } : {},
    });
  } catch {
    sendJSON(res, 400, { ok: false, error: '无效的 multipart/form-data 请求' });
    req.resume();
    return;
  }

  const files = [];
  const inFlight = new Set(); // live { source, dest } pairs, so an abort can tear them down
  let pending = 0;            // file streams still in flight
  let parserClosed = false;
  let responded = false;

  const respond = () => {
    if (responded || !parserClosed || pending > 0) return;
    if (res.writableEnded || res.destroyed || !res.writable) return; // client already gone
    responded = true;
    if (files.length === 0) {
      sendJSON(res, 400, { ok: false, error: '没有收到文件', files: [] });
      return;
    }
    const okCount = files.filter(f => f.ok).length;
    sendJSON(res, okCount > 0 ? 200 : 400, {
      ok: okCount === files.length,
      dir: query.get('dir') || '',
      files,
    });
  };

  busboy.on('file', (_field, file, info) => {
    const name = safeName(info.filename);
    const entry = { ok: false, name, savedAs: null, size: 0, error: null };
    files.push(entry);

    // Open the destination first; if we can't, drain this part and move on.
    let target;
    try {
      target = createUniqueFile(targetDir, name);
    } catch (err) {
      entry.error = '无法创建文件: ' + err.message;
      file.resume(); // drain the part, otherwise the parser stalls
      return;
    }
    entry.savedAs = target.finalName;

    pending++;
    traffic.activeUploads++;

    const dest = path.join(targetDir, target.finalName);
    const meter = meterStream('uploadBytes', n => { entry.size += n; });

    file.on('limit', () => {
      entry.error = `超过单文件上限 ${humanSize(MAX_UPLOAD_BYTES)}`;
    });

    const pair = { source: file, dest: target.stream };
    inFlight.add(pair);

    pipeline(file, meter, target.stream, (err) => {
      inFlight.delete(pair);
      traffic.activeUploads--;
      pending--;

      if (err) {
        entry.ok = false;
        entry.error = entry.error || (req.destroyed || err.code === 'ERR_STREAM_PREMATURE_CLOSE'
          ? '客户端中断'
          : '写入失败: ' + (err.message || err.code));
      } else if (entry.error) {
        entry.ok = false; // tripped the size limit — file on disk is incomplete
      } else {
        entry.ok = true;
      }

      if (entry.ok) {
        respond();
      } else {
        // Never leave a half-written file behind.
        fs.unlink(dest, () => respond());
      }
    });
  });

  busboy.on('error', () => {
    parserClosed = true;
    respond();
  });

  busboy.on('close', () => {
    parserClosed = true;
    respond();
  });

  // Writing to a socket the client already dropped must never crash the server.
  res.on('error', () => {});
  req.on('error', () => {});

  // Client vanished mid-body: busboy will never emit 'close', so tear the
  // in-flight pipes down by hand. pipeline() then reports each one as failed
  // and the half-written file is deleted.
  req.on('close', () => {
    if (req.complete) return; // normal end of request
    parserClosed = true;
    for (const { source, dest } of inFlight) {
      source.destroy();
      dest.destroy();
    }
  });

  req.pipe(busboy);
}

// ── Request handler ────────────────────────────────────────────
function handleRequest(req, res) {
  if (req.url.includes('\0')) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  // Decode URL path
  let urlPath;
  let query;
  try {
    const [rawPath, rawQuery] = req.url.split('?');
    urlPath = decodeURIComponent(rawPath);
    query = new URLSearchParams(rawQuery || '');
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  // ── API: live speeds for the whole server ──
  if (urlPath === '/api/stats') {
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' });
      res.end();
      return;
    }
    sendJSON(res, 200, {
      uploadSpeed: speed.upload,
      downloadSpeed: speed.download,
      activeUploads: traffic.activeUploads,
      activeDownloads: traffic.activeDownloads,
    });
    return;
  }

  // ── API: upload ──
  if (urlPath === '/api/upload') {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return;
    }
    handleUpload(req, res, query);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  // Normalize: strip trailing slash for files, keep for dir listing
  const isDirReq = urlPath.endsWith('/');
  const normalized = urlPath.replace(/\/+$/, '');
  const relPath = normalized.replace(/^\//, '');

  // Security: nothing may resolve outside the share root
  const resolved = safeResolve(relPath);
  if (!resolved) {
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
    if (!isDirReq && urlPath !== '/') {
      res.writeHead(301, { Location: req.url.split('?')[0] + '/' });
      res.end();
      return;
    }
    const html = renderDir(resolved, relPath, ipInfo.primary || 'localhost', PORT);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (!stat.isFile()) {
    res.writeHead(403);
    res.end(renderError(403, '不支持的文件类型'));
    return;
  }

  serveFile(req, res, resolved, stat, req.headers.range);
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
