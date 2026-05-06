import { SOURCES, SOURCE_MAP, ALLOWED_ORIGINS, HEALTH_PROBE_ID, CACHE_TTL } from '../../config.js';

import * as vidzee from '../../sources/vidzee.js';
import * as vidnest from '../../sources/vidnest.js';
import * as vidsrc from '../../sources/vidsrc.js';
import * as vidrock from '../../sources/vidrock.js';
import * as videasy from '../../sources/videasy.js';
import * as cinesu from '../../sources/cinesu.js';
import * as peachify from '../../sources/peachify.js';
import * as lookmovie from '../../sources/lookmovie.js';
import * as vidlink from '../../sources/vidlink.js';
import * as vixsrc from '../../sources/vixsrc.js';

import { getDownloads as get02movieDownloads } from '../../sources/02movie.js';

/* =======================
   🔥 YOUR PHP PROXY HERE
======================= */
const PHP_PROXY = 'https://cdnn.cinesl.top/proxy.php';

const ALL_SOURCE_MODULES = {
    vidzee, vidnest, vidsrc, vidrock, videasy,
    cinesu, peachify, lookmovie, vidlink, vixsrc
};

const SOURCE_MODULES = Object.fromEntries(
    Object.entries(ALL_SOURCE_MODULES).filter(([key]) => {
        const sourceConfig = SOURCE_MAP[key];
        return sourceConfig && !sourceConfig.disabled;
    })
);

const SUBTITLE_BASE = 'https://sub.vdrk.site/v1';

const UA_LIST = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
];

const getUA = () => UA_LIST[Math.floor(Math.random() * UA_LIST.length)];

const cache = new Map();

function getCached(key, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < CACHE_TTL) return Promise.resolve(hit.val);
    return fn().then(val => {
        if (val) cache.set(key, { val, ts: Date.now() });
        return val;
    });
}

const jitter = (ms) => new Promise(r => setTimeout(r, Math.random() * ms));

async function withRetry(fn, attempts = 3, delay = 1000) {
    for (let i = 0; i < attempts; i++) {
        try {
            const result = await fn();
            if (result) return result;
        } catch {
            if (i === attempts - 1) return null;
            await new Promise(r => setTimeout(r, delay * (i + 1)));
        }
    }
    return null;
}

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => resolve(null), ms))
    ]);
}

async function fetchUpstream(url, redirects = 0, extraHeaders = {}) {
    if (redirects > 5) throw new Error('redirect loop');
    const res = await fetch(url, {
        headers: { 'User-Agent': getUA(), ...extraHeaders },
        redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location'), url).href;
        return fetchUpstream(next, redirects + 1, extraHeaders);
    }
    return res;
}

/* =======================
   🔥 FIXED M3U8 REWRITE
======================= */
function rewriteM3u8(body, url, extraParam = '') {
    const base = url.split('?')[0];
    const dir = base.slice(0, base.lastIndexOf('/') + 1);
    const origin = new URL(url).origin;

    return body.split('\n').map(line => {
        const t = line.trim();
        if (!t) return line;

        if (t.startsWith('#')) {
            return t.replace(/URI="([^"]+)"/g, (match, uri) => {
                const abs =
                    uri.startsWith('http') ? uri :
                    uri.startsWith('/') ? origin + uri :
                    dir + uri;

                if (abs.includes('tiktokcdn.com')) {
                    return `URI="${abs}"`;
                }

                return `URI="${PHP_PROXY}?url=${encodeURIComponent(abs)}${extraParam}"`;
            });
        }

        const abs =
            t.startsWith('http') ? t :
            t.startsWith('/') ? origin + t :
            dir + t;

        return `${PHP_PROXY}?url=${encodeURIComponent(abs)}${extraParam}`;
    }).join('\n');
}

/* =======================
   FETCH SOURCE
======================= */
function fetchSource(cfg, cacheKey, id, s, e, clientIP = null, env = null) {
    const mod = SOURCE_MODULES[cfg.key];
    const tmdbKey = cfg.key === 'lookmovie' ? env?.TMDB_API_KEY : null;

    if (cfg.multiBase) {
        return withTimeout(
            jitter(cfg.jitter).then(async () => {
                for (const base of mod.BASES) {
                    const key = `${cfg.key}-${base}-${cacheKey}`;
                    const result = await getCached(key, () =>
                        withRetry(() => mod.getStream(id, s, e, base, clientIP), cfg.retries, 500)
                    ).catch(() => null);

                    if (result) return result;
                }
                return null;
            }),
            cfg.timeout
        );
    }

    return withTimeout(
        jitter(cfg.jitter).then(() =>
            getCached(`${cfg.key}-${cacheKey}`, () =>
                withRetry(() => mod.getStream(id, s, e, tmdbKey, clientIP), cfg.retries, 1000)
            ).catch(() => null)
        ),
        cfg.timeout
    );
}

/* =======================
   WRAP URL (FIXED)
======================= */
function wrapUrl(rawUrl, sourceKey) {
    if (!rawUrl) return null;
    const raw = typeof rawUrl === 'object' ? rawUrl.url : rawUrl;
    const cfg = SOURCE_MAP[sourceKey];
    if (!cfg || cfg.skipProxy) return raw;

    return `${PHP_PROXY}?url=${encodeURIComponent(raw)}&${cfg.proxyParam}=1`;
}

/* =======================
   VERIFY STREAM
======================= */
async function verifyStream(rawUrl, sourceKey) {
    const mod = SOURCE_MODULES[sourceKey];
    if (!mod.VERIFY_HEADERS) return true;

    try {
        const res = await Promise.race([
            fetch(rawUrl, { headers: { 'User-Agent': getUA(), ...mod.VERIFY_HEADERS } }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
        ]);

        if (res.status >= 400) return false;
        const text = await res.text();
        return text.trim().startsWith('#EXTM3U');
    } catch {
        return false;
    }
}

/* =======================
   ALL SOURCES
======================= */
async function getAllWorkingSources(id, s, e, clientIP = null, env = null) {
    const cacheKey = `${id}-${s || ''}-${e || ''}`;

    const fetched = await Promise.all(
        SOURCES.filter(cfg => !cfg.disabled).map(cfg =>
            fetchSource(cfg, cacheKey, id, s, e, clientIP, env)
                .then(r => ({ raw: r, source: cfg.key }))
                .catch(() => ({ raw: null, source: cfg.key }))
        )
    );

    const candidates = fetched.filter(c => c.raw);

    const verified = await Promise.all(
        candidates.map(async c => {
            const raw = typeof c.raw === 'object' ? c.raw.url : c.raw;
            const ok = await verifyStream(raw, c.source);
            if (!ok) return null;

            const cfg = SOURCE_MAP[c.source];
            return {
                source: c.source,
                label: cfg?.label ?? c.source,
                url: wrapUrl(c.raw, c.source),
            };
        })
    );

    return verified.filter(Boolean);
}

/* =======================
   SUBTITLES
======================= */
async function fetchSubtitles(url) {
    try {
        const res = await fetch(url, { headers: { 'User-Agent': getUA() } });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

/* =======================
   API HANDLER (ONLY CHANGED PROXY PARTS)
======================= */
export async function onRequest({ request, env }) {
    const clientIP = request.headers.get('CF-Connecting-IP') || null;
    const origin = request.headers.get('origin') || '';

    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
    };

    const reqUrl = new URL(request.url);
    const q = Object.fromEntries(reqUrl.searchParams);

    /* =======================
       MAIN PROXY ENDPOINT FIXED
    ======================= */
    if (q.url || q.proxy) {
        try {
            const rawUrl = decodeURIComponent(q.url || q.proxy);

            const proxyUrl = `${PHP_PROXY}?url=${encodeURIComponent(rawUrl)}${q.tt ? '&tt=1' : ''}`;

            const upstream = await fetch(proxyUrl);

            const contentType = upstream.headers.get('content-type') || '';

            if (contentType.includes('mpegurl') || rawUrl.includes('.m3u8')) {
                const text = await upstream.text();
                return new Response(rewriteM3u8(text, rawUrl), {
                    headers: {
                        'Content-Type': 'application/vnd.apple.mpegurl',
                        ...corsHeaders
                    }
                });
            }

            return new Response(upstream.body, {
                headers: corsHeaders
            });

        } catch (e) {
            return new Response(e.message, { status: 502, headers: corsHeaders });
        }
    }

    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
}
