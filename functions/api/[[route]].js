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

const ALL_SOURCE_MODULES = { vidzee, vidnest, vidsrc, vidrock, videasy, cinesu, peachify, lookmovie, vidlink, vixsrc };

const SOURCE_MODULES = Object.fromEntries(
    Object.entries(ALL_SOURCE_MODULES).filter(([key]) => {
        const sourceConfig = SOURCE_MAP[key];
        return sourceConfig && !sourceConfig.disabled;
    })
);

const PROXY = "https://cdn.cinesl.top/proxy.php";

// ---------------- KEEP YOUR ORIGINAL FUNCTIONS ----------------

const SUBTITLE_BASE = 'https://sub.vdrk.site/v1';

const UA_LIST = [
    'Mozilla/5.0 Chrome/124.0 Safari/537.36',
    'Mozilla/5.0 Firefox/125.0',
    'Mozilla/5.0 Safari/605.1.15',
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
        } catch {}
        await new Promise(r => setTimeout(r, delay * (i + 1)));
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

// ---------------- ONLY FIXED PART ----------------
function wrapUrl(rawUrl, sourceKey) {
    if (!rawUrl) return null;

    const raw = typeof rawUrl === 'object' ? rawUrl.url : rawUrl;
    const cfg = SOURCE_MAP[sourceKey];

    if (!cfg || cfg.skipProxy) return raw;

    return `${PROXY}?url=${encodeURIComponent(raw)}`;
}

// ---------------- YOUR ORIGINAL FUNCTIONS (UNCHANGED) ----------------
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

            const cfg = SOURCE_MAP[c.source];

            return {
                source: c.source,
                label: cfg?.label ?? c.source,
                url: wrapUrl(raw, c.source),
            };
        })
    );

    return verified.filter(Boolean);
}

// ---------------- MAIN API ----------------
export async function onRequest({ request, env }) {
    const clientIP = request.headers.get('CF-Connecting-IP') || null;

    const url = new URL(request.url);
    const q = Object.fromEntries(url.searchParams);

    const cors = {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
    };

    // ---------------- MOVIE ----------------
    if (url.pathname === "/api/movie") {
        const sources = await getAllWorkingSources(q.id, null, null, clientIP, env);
        return new Response(JSON.stringify({ sources }, null, 2), { headers: cors });
    }

    // ---------------- TV ----------------
    if (url.pathname === "/api/tv") {
        const sources = await getAllWorkingSources(q.id, q.season, q.episode, clientIP, env);
        return new Response(JSON.stringify({ sources }, null, 2), { headers: cors });
    }

    // ---------------- PROXY FIX (IMPORTANT PART ONLY) ----------------
    if (url.pathname === "/api") {
        if (q.url || q.proxy) {
            const rawUrl = decodeURIComponent(q.url || q.proxy);

            const forwardHeaders = {
                "User-Agent": request.headers.get("user-agent") || getUA(),
                "Referer": request.headers.get("referer") || "",
                "Origin": request.headers.get("origin") || "",
                "Range": request.headers.get("range") || ""
            };

            const proxyUrl = `${PROXY}?url=${encodeURIComponent(rawUrl)}`;

            const res = await fetch(proxyUrl, {
                headers: forwardHeaders
            });

            const type = res.headers.get("content-type") || "";

            return new Response(res.body, {
                headers: {
                    "Content-Type": type,
                    "Access-Control-Allow-Origin": "*"
                }
            });
        }

        return new Response(JSON.stringify({ error: "missing url" }), {
            status: 400,
            headers: cors
        });
    }

    return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: cors
    });
}
