// Globais injetados em tempo de build pelo Vite (define) e ponte do Electron.
// __APP_VERSION__: versão atual do app (vinda do package.json).
// __UPDATE_REPO__: "owner/repo" público de onde sai a última release.
declare const __APP_VERSION__: string;
declare const __UPDATE_REPO__: string;

interface Window {
  // Exposto pelo preload do Electron (só no desktop). Ausente na web/Android.
  prozaUpdater?: {
    onAvailable(cb: (info: { version: string }) => void): void;
    onProgress(cb: (info: { percent: number }) => void): void;
    onDownloaded(cb: (info: { version: string }) => void): void;
    onError(cb: (msg: string) => void): void;
    quitAndInstall(): void;
    check(): void;
  };
}
