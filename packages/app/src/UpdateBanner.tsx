import { useEffect, useRef, useState } from 'react';

// Banner "Atualização disponível", multiplataforma:
//  - PC (Electron): escuta o electron-updater (baixa em 2º plano) e oferece "Reiniciar".
//  - Android (TV/celular): consulta a última release pública do GitHub, compara a versão
//    e, ao confirmar, baixa+instala o APK pelo plugin nativo AppUpdater.
//  - Web: abre a página da release p/ download manual.

type Phase = 'idle' | 'available' | 'downloading' | 'ready';

const SKIP_KEY = 'proza.update.skip.v1';

// true se `b` é mais novo que `a` (semver simples major.minor.patch).
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (y !== x) return y > x;
  }
  return false;
}

export function UpdateBanner() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [version, setVersion] = useState('');
  const [percent, setPercent] = useState(0);
  const apkUrl = useRef<string>('');
  const isElectron = typeof window !== 'undefined' && !!window.prozaUpdater;

  // PC (Electron): eventos do processo principal.
  useEffect(() => {
    const up = typeof window !== 'undefined' ? window.prozaUpdater : undefined;
    if (!up) return;
    up.onAvailable((info) => { setVersion(info?.version || ''); setPhase('downloading'); });
    up.onProgress((info) => setPercent(info?.percent || 0));
    up.onDownloaded((info) => { setVersion(info?.version || ''); setPhase('ready'); });
    up.onError(() => { /* silencioso: não atrapalha quem está assistindo */ });
  }, []);

  // Android/web: pergunta ao GitHub qual é a última release.
  useEffect(() => {
    if (isElectron) return;
    let dead = false;
    (async () => {
      try {
        const r = await fetch(`https://api.github.com/repos/${__UPDATE_REPO__}/releases/latest`, {
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (!r.ok) return; // 404 = ainda não há release publicada
        const j: any = await r.json();
        const tag = String(j.tag_name || '').replace(/^v/i, '');
        if (!tag || !isNewer(__APP_VERSION__, tag)) return;
        // Respeita um "depois" anterior pra mesma versão (não fica insistindo).
        try { if (localStorage.getItem(SKIP_KEY) === tag) return; } catch { }
        const apk = (j.assets || []).find((a: any) => /\.apk$/i.test(a.name));
        apkUrl.current = apk?.browser_download_url || j.html_url || '';
        if (!dead) { setVersion(tag); setPhase('available'); }
      } catch { /* offline / rate-limit: ignora */ }
    })();
    return () => { dead = true; };
  }, [isElectron]);

  async function onAct() {
    if (isElectron) { if (phase === 'ready') window.prozaUpdater!.quitAndInstall(); return; }
    try {
      const cap: any = await import('@capacitor/core');
      if (cap?.Capacitor?.isNativePlatform?.()) {
        const AppUpdater = cap.registerPlugin('AppUpdater');
        const can = await AppUpdater.canInstall().catch(() => ({ granted: true }));
        if (!can?.granted) { await AppUpdater.openInstallSettings(); return; }
        setPhase('downloading');
        await AppUpdater.downloadAndInstall({ url: apkUrl.current }).catch(() => { });
        return;
      }
    } catch { /* não é nativo: cai no download web */ }
    if (apkUrl.current && typeof window !== 'undefined') window.open(apkUrl.current, '_blank');
  }

  function dismiss() {
    if (!isElectron && version) { try { localStorage.setItem(SKIP_KEY, version); } catch { } }
    setPhase('idle');
  }

  if (phase === 'idle') return null;

  const label =
    phase === 'ready' ? `Atualização ${version} pronta`
      : phase === 'downloading' ? (isElectron ? `Baixando atualização… ${percent}%` : 'Baixando atualização…')
        : `Nova versão disponível: ${version}`;
  const actionable = phase === 'available' || phase === 'ready';

  return (
    <div className="update-banner" role="status">
      <span className="update-dot" />
      <span className="update-msg">{label}</span>
      {actionable && (
        <button className="update-btn" onClick={onAct}>
          {phase === 'ready' ? 'Reiniciar e instalar' : 'Atualizar agora'}
        </button>
      )}
      <button className="update-x" aria-label="Dispensar" onClick={dismiss}>✕</button>
    </div>
  );
}
