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
   🔥 YOUR PHP PROXY
======================= */
const PHP_PROXY = 'https://cdn.cinesl.top/proxy.php';

const ALL_SOURCE_MODULES = {
    vidzee, vidnest, vidsrc, vidrock, videasy,
    cinesu, peachify, lookmovie, vidlink, vixsrc
};

const SOURCE_MODULES = Object.fromEntries(
    Object.entries(ALL_SOURCE_MODULES).filter(([key]) => {
        const cfg = SOURCE_MAP[key];
        return cfg && !cfg.disabled;
    })
);

const SUBTITLE_BASE = 'https://sub.vdrk.site/v1';

/* =======================
   USER AGENTS
======================= */
const UA_LIST = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
    'Mozilla/5.0 (X11; Linux x86_64) Gecko Firefox/125.0'
];

const getUA = () => UA_LIST[Math.floor(Math.random() * UA_LIST.length)];

/* =======================
   CACHE
======================= */
const cache = new Map();

function getCached(key, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < CACHE_TTL) return Promise.resolve(hit.val);
    return fn().then(val => {
        if (val) cache.set(key, { val, ts: Date.now() });
        return val;
    });
}

/* =======================
   UTILS
======================= */
const delay = ms => new Promise(r => setTimeout(r, ms));

function withTimeout(p, ms) {
    return Promise.race([
        p,
        new Promise(r => setTimeout(() => r(null), ms))
    ]);
}

/* =======================
   FIXED PHP PROXY WRAPPER
======================= */
const proxy = (url, extra = '') =>
    `${PHP_PROXY}?url=${encodeURIComponent(url)}${extra}`;

/* =======================
   M3U8 REWRITE FIXED
======================= */
function rewriteM3u8(body, url, extraParam = '') {
    const base = url.split('?')[0];
    const dir = base.slice(0, base.lastIndexOf('/') + 1);
    const origin = new URL(url).origin;

    return body.split('\n').map(line => {
        const t = line.trim();
        if (!t) return line;

        if (t.startsWith('#')) {
            return t.replace(/URI="([^"]+)"/g, (m, uri) => {
                const abs =
                    uri.startsWith('http') ? uri :
                    uri.startsWith('/') ? origin + uri :
                    dir + uri;

                if (abs.includes('tiktokcdn.com')) return `URI="${abs}"`;

                return `URI="${proxy(abs, extraParam)}"`;
            });
        }

        const abs =
            t.startsWith('http') ? t :
            t.startsWith('/') ? origin + t :
            dir + t;

        return proxy(abs, extraParam);
    }).join('\n');
}

/* =======================
   FETCH UPSTREAM SOURCE
======================= */
async function fetchSource(cfg, id, s, e, env) {
    const mod = SOURCE_MODULES[cfg.key];
    const tmdbKey = env?.TMDB_API_KEY;

    return withTimeout(
        getCached(`${cfg.key}-${id}-${s}-${e}`, async () => {
            if (cfg.multiBase) {
                for (const base of mod.BASES) {
                    const r = await mod.getStream(id, s, e, base);
                    if (r) return r;
                }
                return null;
            }
            return mod.getStream(id, s, e, tmdbKey);
        }),
        cfg.timeout
    );
}

/* =======================
   WRAP URL
======================= */
function wrapUrl(url, key) {
    if (!url) return null;
    const raw = typeof url === 'object' ? url.url : url;
    const cfg = SOURCE_MAP[key];
    if (!cfg || cfg.skipProxy) return raw;

    return proxy(raw, `&${cfg.proxyParam}=1`);
}

/* =======================
   VERIFY STREAM
======================= */
async function verifyStream(url, key) {
    const mod = SOURCE_MODULES[key];
    if (!mod.VERIFY_HEADERS) return true;

    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': getUA(), ...mod.VERIFY_HEADERS }
        });

        if (!res.ok) return false;
        const txt = await res.text();
        return txt.startsWith('#EXTM3U');
    } catch {
        return false;
    }
}

/* =======================
   GET SOURCES
======================= */
async function getAllWorkingSources(id, s, e, env) {
    const results = await Promise.all(
        SOURCES.filter(c => !c.disabled).map(async cfg => {
            try {
                const raw = await fetchSource(cfg, id, s, e, env);
                if (!raw) return null;

                const ok = await verifyStream(raw.url || raw, cfg.key);
                if (!ok) return null;

                return {
                    source: cfg.key,
                    label: cfg.label,
                    url: wrapUrl(raw, cfg.key)
                };
            } catch {
                return null;
            }
        })
    );

    return results.filter(Boolean);
}

/* =======================
   SUBTITLES
======================= */
async function fetchSubtitles(url) {
    try {
        const r = await fetch(url, { headers: { 'User-Agent': getUA() } });
        if (!r.ok) return null;
        return await r.json();
    } catch {
        return null;
    }
}

/* =======================
   MAIN ROUTER
======================= */
export async function onRequest({ request, env }) {
    const url = new URL(request.url);
    const path = url.pathname;
    const q = Object.fromEntries(url.searchParams);

    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
    };

    /* =======================
       MOVIE
    ======================= */
    if (path === '/api/movie') {
        const sources = await getAllWorkingSources(q.id, null, null, env);
        const subtitles = await fetchSubtitles(`${SUBTITLE_BASE}/movie/${q.id}`);

        return new Response(JSON.stringify({ sources, subtitles }), { headers: cors });
    }

    /* =======================
       TV
    ======================= */
    if (path === '/api/tv') {
        const sources = await getAllWorkingSources(q.id, q.season, q.episode, env);
        const subtitles = await fetchSubtitles(`${SUBTITLE_BASE}/tv/${q.id}/${q.season}/${q.episode}`);

        return new Response(JSON.stringify({ sources, subtitles }), { headers: cors });
    }

    /* =======================
       MAIN PROXY (FIXED)
    ======================= */
    if (q.url) {
        const raw = decodeURIComponent(q.url);
        const proxyUrl = proxy(raw, q.tt ? '&tt=1' : '');

        const r = await fetch(proxyUrl);
        const ct = r.headers.get('content-type') || '';

        if (ct.includes('mpegurl') || raw.includes('.m3u8')) {
            const text = await r.text();
            return new Response(rewriteM3u8(text, raw), {
                headers: {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    ...cors
                }
            });
        }

        return new Response(r.body, { headers: cors });
    }

    /* =======================
       FALLBACK (NOW FIXED)
    ======================= */
    return new Response(JSON.stringify({
        error: 'invalid route',
        available: ['/api/movie', '/api/tv', '/api?url=']
    }), { status: 404, headers: cors });
}
