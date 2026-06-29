// Persistência à prova de bala no desktop: espelha as chaves do app (login, favoritos,
// continuar assistindo, etc.) num ARQUIVO no userData — independente da porta/origem e
// gravado na hora (sobrevive a fechar forçado, troca de porta, limpeza de cache).
// O app continua usando localStorage normalmente; aqui só hidratamos na abertura e
// espelhamos as gravações.
const { ipcRenderer } = require('electron');

// Ponte de auto-update p/ o renderer (banner). Só existe no desktop Electron — na
// web/Android `window.prozaUpdater` é undefined e o app usa o caminho do GitHub direto.
try {
  window.prozaUpdater = {
    onAvailable: (cb) => ipcRenderer.on('proza-update-available', (_e, info) => cb(info)),
    onProgress: (cb) => ipcRenderer.on('proza-update-progress', (_e, info) => cb(info)),
    onDownloaded: (cb) => ipcRenderer.on('proza-update-downloaded', (_e, info) => cb(info)),
    onError: (cb) => ipcRenderer.on('proza-update-error', (_e, msg) => cb(msg)),
    quitAndInstall: () => ipcRenderer.send('proza-update-install'),
    check: () => ipcRenderer.send('proza-update-check'),
  };
} catch { /* sem window (improvável no preload) */ }

// Chaves que devem persistir entre sessões.
const PERSIST = [
  'proza.config.v1',     // login/provedor (o principal)
  'proza.fav.v1',        // favoritos
  'proza.progress.v1',   // continuar assistindo
  'proza.watched.v1',    // episódios vistos
  'proza.cw.v1',         // fila "continuar"
  'proza.chanwatch.v1',  // mais assistidos
  'proza.engine.v2',     // engine de vídeo aprendida
  'proza.vodcat.v1',     // última categoria
  'proza.vodempty.v1',   // categorias vazias
];

try {
  const proto = Object.getPrototypeOf(window.localStorage);
  const origSet = proto.setItem;
  const origRemove = proto.removeItem;

  // 1) Hidrata: se o localStorage (preso à porta) não tem a chave mas o arquivo tem,
  //    restaura. Assim o login sobrevive mesmo se a origem/porta mudar.
  const saved = ipcRenderer.sendSync('proza-store-get') || {};
  // Hidrata chaves novas (proza.*) E legadas (rajada.*) que estiverem no arquivo — as
  // legadas são migradas p/ proza.* no boot do app (ver main.tsx), sem perder login.
  for (const k of Object.keys(saved)) {
    if ((k.startsWith('proza.') || k.startsWith('rajada.')) && saved[k] != null && window.localStorage.getItem(k) == null) {
      origSet.call(window.localStorage, k, saved[k]);
    }
  }

  // 2) Espelha gravações/remoções das chaves persistentes pro arquivo.
  proto.setItem = function (k, v) {
    origSet.call(this, k, v);
    if (PERSIST.includes(k)) { try { ipcRenderer.send('proza-store-set', { k, v: String(v) }); } catch { } }
  };
  proto.removeItem = function (k) {
    origRemove.call(this, k);
    if (PERSIST.includes(k)) { try { ipcRenderer.send('proza-store-del', k); } catch { } }
  };
} catch { /* se algo falhar, o app só usa o localStorage normal */ }
