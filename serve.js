// 零依赖静态服务器：本工程的本地预览用它（Node 已经因为 electron 装好了）。
// 用法: node serve.js [port]
// 页面会用 fetch 加载 music/ 下的音频，所以必须走 http，不能直接双击 index.html。

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || 8392);
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm'
};

function resolveSafe(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch (e) {
    return null;
  }
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

const server = http.createServer((req, res) => {
  const abs = resolveSafe(req.url || '/');
  if (!abs) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('forbidden');
    return;
  }

  let file = abs;
  let stat;
  try {
    stat = fs.statSync(file);
    if (stat.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = fs.statSync(file);
    }
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 not found: ' + req.url);
    console.log('404', req.url);
    return;
  }

  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const total = stat.size;
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'Accept-Ranges': 'bytes'
  };

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] === '' ? null : Number(m[1]);
      let end = m[2] === '' ? null : Number(m[2]);
      if (start === null && end === null) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + total }).end();
        return;
      }
      if (start === null) {
        start = Math.max(0, total - end);
        end = total - 1;
      } else if (end === null || end >= total) {
        end = total - 1;
      }
      if (start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + total }).end();
        return;
      }
      res.writeHead(206, Object.assign({}, headers, {
        'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
        'Content-Length': end - start + 1
      }));
      fs.createReadStream(file, { start: start, end: end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, Object.assign({}, headers, { 'Content-Length': total }));
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用，可能服务器已经在运行了。');
    console.error('访问地址: http://' + HOST + ':' + PORT + '/');
  } else {
    console.error(e);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('魔法少女的审判前夜 - 本地服务器已启动');
  console.log('访问地址: http://' + HOST + ':' + PORT + '/');
  console.log('按 Ctrl+C 停止');
});
