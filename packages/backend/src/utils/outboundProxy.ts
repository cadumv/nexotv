import env from '../config/env';

/**
 * Anti-403: if OUTBOUND_PROXY is set, route all server-side fetch() calls
 * (the Xtream catalog/metadata requests) through a clean-IP proxy so the
 * IPTV provider doesn't see a blocked datacenter IP. Video playback is
 * unaffected (it goes directly from the client).
 */
export async function setupOutboundProxy() {
    const proxy = env.OUTBOUND_PROXY;
    if (!proxy) return;
    try {
        const undici = await import('undici');
        undici.setGlobalDispatcher(new undici.ProxyAgent(proxy));
        const safe = proxy.replace(/\/\/[^@]*@/, '//***@'); // hide credentials in logs
        console.log(`[PROXY] Outbound fetches routed through proxy: ${safe}`);
    } catch (e: any) {
        console.error('[PROXY] Failed to configure outbound proxy:', e?.message);
    }
}
