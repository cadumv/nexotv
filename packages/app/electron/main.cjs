// Processo principal do Electron — embrulha a web app (dist/) como app de desktop.
// Serve o dist/ num http://127.0.0.1:<porta> local (mesma situação do localhost que
// já toca vídeo) e abre numa janela Chromium com webSecurity desligado, pra liberar
// o fetch HTTP do provedor (sem CORS, sem mixed-content).
const { app, BrowserWindow, shell, session, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

// Store em ARQUIVO (login/favoritos/etc.) — gravado na hora, independente de porta.
const STORE_FILE = () => path.join(app.getPath('userData'), 'rajada-store.json');
function readStore() { try { return JSON.parse(fs.readFileSync(STORE_FILE(), 'utf8')); } catch { return {}; } }
function writeStore(obj) { try { fs.writeFileSync(STORE_FILE(), JSON.stringify(obj)); } catch { /* noop */ } }
ipcMain.on('rajada-store-get', (e) => { e.returnValue = readStore(); });
ipcMain.on('rajada-store-set', (_e, { k, v }) => { const s = readStore(); s[k] = v; writeStore(s); });
ipcMain.on('rajada-store-del', (_e, k) => { const s = readStore(); delete s[k]; writeStore(s); });

const DIST = path.join(__dirname, '..', 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.map': 'application/json',
};

// Porta FIXA: o localStorage (login, favoritos, "continuar assistindo") é isolado
// por origem (inclui a porta). Porta aleatória = perde o login a cada abertura.
const PORT = 41789;

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
    server.listen(PORT, '127.0.0.1', () => resolve(PORT));
  });
}

// Libera CORS/insecure no nível do Chromium (reforça o webSecurity:false da janela).
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors,BlockInsecurePrivateNetworkRequests');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

async function createWindow() {
  // App próprio: libera permissões (microfone p/ busca por voz, mídia, etc.).
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(true));
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
      contextIsolation: false,     // preload compartilha contexto p/ espelhar o localStorage
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  // Links externos abrem no navegador padrão, não dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL(`http://127.0.0.1:${port}/`);
}

// Instância única: 2ª abertura foca a janela existente (e não colide na porta fixa).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });
  app.whenReady().then(createWindow);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on('window-all-closed', () => app.quit());
}
