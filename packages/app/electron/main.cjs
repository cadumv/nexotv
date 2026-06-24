// Processo principal do Electron — embrulha a web app (dist/) como app de desktop.
// Serve o dist/ num http://127.0.0.1:<porta> local (mesma situação do localhost que
// já toca vídeo) e abre numa janela Chromium com webSecurity desligado, pra liberar
// o fetch HTTP do provedor (sem CORS, sem mixed-content).
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

const DIST = path.join(__dirname, '..', 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.map': 'application/json',
};

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        let p = decodeURIComponent((req.url || '/').split('?')[0]);
        if (p === '/' || p === '') p = '/index.html';
        let file = path.join(DIST, p);
        // SPA fallback: caminho inexistente cai no index.html.
        if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          file = path.join(DIST, 'index.html');
        }
        res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      } catch (e) {
        res.statusCode = 500; res.end('err');
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// Libera CORS/insecure no nível do Chromium (reforça o webSecurity:false da janela).
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors,BlockInsecurePrivateNetworkRequests');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

async function createWindow() {
  const port = await startServer();
  const win = new BrowserWindow({
    width: 1366,
    height: 820,
    backgroundColor: '#0b0b0f',
    autoHideMenuBar: true,
    title: 'Rajada',
    webPreferences: {
      webSecurity: false,          // libera fetch HTTP do provedor (sem CORS/mixed-content)
      allowRunningInsecureContent: true,
      backgroundThrottling: false,
    },
  });
  // Links externos abrem no navegador padrão, não dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(createWindow);
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => app.quit());
