import React, { useEffect, useState, useCallback } from 'react';
import type { AddonConfig, EngineOptions, NexoEngine } from '@nexotv/core';
import { createEngine } from './engineHost';

const LS_KEY = 'rajada.config.v1';

interface SavedConfig { config: AddonConfig; options: EngineOptions; }

function loadSaved(): SavedConfig | null {
    try { const r = localStorage.getItem(LS_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
}

/** Tela de setup (login IPTV). Sem segredos no repo — o usuário digita. */
function Setup({ onSave }: { onSave: (s: SavedConfig) => void }) {
    const [url, setUrl] = useState('');
    const [user, setUser] = useState('');
    const [pass, setPass] = useState('');
    const [agenda, setAgenda] = useState('');
    return (
        <div className="setup">
            <h1 className="brand">RAJADA</h1>
            <p>Conecte seu IPTV (Xtream)</p>
            <input placeholder="URL (http://servidor.com)" value={url} onChange={e => setUrl(e.target.value)} />
            <input placeholder="Usuário" value={user} onChange={e => setUser(e.target.value)} />
            <input placeholder="Senha" type="password" value={pass} onChange={e => setPass(e.target.value)} />
            <input placeholder="Agenda URL (opcional, Worker /agenda)" value={agenda} onChange={e => setAgenda(e.target.value)} />
            <button onClick={() => onSave({
                config: { provider: 'xtream', xtreamUrl: url.trim(), xtreamUsername: user.trim(), xtreamPassword: pass.trim(), enableVod: true },
                options: { addonName: 'Rajada', sofascoreAgendaUrl: agenda.trim() || null },
            })}>Entrar</button>
        </div>
    );
}

interface Row { id: string; type: string; name: string; metas: any[]; }

function App() {
    const [saved, setSaved] = useState<SavedConfig | null>(loadSaved());
    const [engine, setEngine] = useState<NexoEngine | null>(null);
    const [rows, setRows] = useState<Row[]>([]);
    const [status, setStatus] = useState('');

    const boot = useCallback(async (s: SavedConfig) => {
        setStatus('Carregando…');
        try {
            const eng = await createEngine(s.config, s.options);
            setEngine(eng);
            const man = eng.getManifest();
            // Mostra as fileiras base (jogos, canais, filmes, séries) — Netflix-style.
            const base = man.catalogs.filter((c: any) => ['nexotv_games', 'iptv_channels', 'nexotv_vod', 'nexotv_series'].includes(c.id));
            const built: Row[] = [];
            for (const c of base) {
                const { metas } = await eng.getCatalog({ type: c.type, id: c.id });
                if (metas.length) built.push({ id: c.id, type: c.type, name: c.name, metas: metas.slice(0, 30) });
            }
            setRows(built);
            setStatus('');
        } catch (e: any) {
            setStatus('Erro: ' + (e?.message || e));
        }
    }, []);

    useEffect(() => { if (saved) boot(saved); }, [saved, boot]);

    if (!saved) return <Setup onSave={(s) => { localStorage.setItem(LS_KEY, JSON.stringify(s)); setSaved(s); }} />;

    return (
        <div className="home">
            <header className="topbar"><span className="brand-sm">RAJADA</span>
                <button className="logout" onClick={() => { localStorage.removeItem(LS_KEY); setSaved(null); setEngine(null); setRows([]); }}>sair</button>
            </header>
            {status && <div className="status">{status}</div>}
            {rows.map(row => (
                <section className="row" key={row.id}>
                    <h2>{row.name}</h2>
                    <div className="tiles">
                        {row.metas.map((m: any) => (
                            <Tile key={m.id} meta={m} onPlay={async () => {
                                if (!engine) return;
                                const streams = await engine.getStreams(m.id);
                                if (streams[0]?.url) window.open(streams[0].url, '_blank');
                            }} />
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}

function Tile({ meta, onPlay }: { meta: any; onPlay: () => void }) {
    const shape = meta.posterShape || 'poster';
    return (
        <button className={`tile ${shape}`} onClick={onPlay} title={meta.name}>
            {meta.poster && <img src={meta.poster} alt={meta.name} loading="lazy" />}
            <span className="tile-name">{meta.name}</span>
        </button>
    );
}

export default App;
