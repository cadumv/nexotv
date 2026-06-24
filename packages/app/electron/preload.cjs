// Persistência à prova de bala no desktop: espelha as chaves do app (login, favoritos,
// continuar assistindo, etc.) num ARQUIVO no userData — independente da porta/origem e
// gravado na hora (sobrevive a fechar forçado, troca de porta, limpeza de cache).
// O app continua usando localStorage normalmente; aqui só hidratamos na abertura e
// espelhamos as gravações.
const { ipcRenderer } = require('electron');

// Chaves que devem persistir entre sessões.
const PERSIST = [
  'rajada.config.v1',     // login/provedor (o principal)
  'rajada.fav.v1',        // favoritos
  'rajada.progress.v1',   // continuar assistindo
  'rajada.watched.v1',    // episódios vistos
  'rajada.cw.v1',         // fila "continuar"
  'rajada.chanwatch.v1',  // mais assistidos
  'rajada.engine.v2',     // engine de vídeo aprendida
  'rajada.vodcat.v1',     // última categoria
  'rajada.vodempty.v1',   // categorias vazias
];

try {
  const proto = Object.getPrototypeOf(window.localStorage);
  const origSet = proto.setItem;
  const origRemove = proto.removeItem;

  // 1) Hidrata: se o localStorage (preso à porta) não tem a chave mas o arquivo tem,
  //    restaura. Assim o login sobrevive mesmo se a origem/porta mudar.
  const saved = ipcRenderer.sendSync('rajada-store-get') || {};
  for (const k of PERSIST) {
    if (saved[k] != null && window.localStorage.getItem(k) == null) {
      origSet.call(window.localStorage, k, saved[k]);
    }
  }

  // 2) Espelha gravações/remoções das chaves persistentes pro arquivo.
  proto.setItem = function (k, v) {
    origSet.call(this, k, v);
    if (PERSIST.includes(k)) { try { ipcRenderer.send('rajada-store-set', { k, v: String(v) }); } catch { } }
  };
  proto.removeItem = function (k) {
    origRemove.call(this, k);
    if (PERSIST.includes(k)) { try { ipcRenderer.send('rajada-store-del', k); } catch { } }
  };
} catch { /* se algo falhar, o app só usa o localStorage normal */ }
