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

// 🔥 PHP PROXY BASE (CHANGE THIS)
const PHP_PROXY = "https://cdn.cinesl.top/proxy.php";

const SUBTITLE_BASE = 'https://sub.vdrk.site/v1';

const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) Firefox/125.0',
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
      const r = await fn();
      if (r) return r;
    } catch {}
    await new Promise(r => setTimeout(r, delay * (i + 1)));
  }
  return null;
}

function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise(res => setTimeout(() => res(null), ms))
  ]);
}

async function fetchUpstream(url, redirects = 0) {
  if (redirects > 5) throw new Error("redirect loop");

  const res = await fetch(url, {
    headers: { 'User-Agent': getUA() },
    redirect: 'manual'
  });

  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    const next = new URL(res.headers.get('location'), url).href;
    return fetchUpstream(next, redirects + 1);
  }

  return res;
}

// 🔥 REPLACED: Cloudflare proxy → PHP proxy
function wrapUrl(rawUrl, sourceKey) {
  if (!rawUrl) return null;
  const url = typeof rawUrl === 'object' ? rawUrl.url : rawUrl;

  const cfg = SOURCE_MAP[sourceKey];
  if (!cfg || cfg.skipProxy) return url;

  return `${PHP_PROXY}?url=${encodeURIComponent(url)}&source=${sourceKey}`;
}

// -------- STREAM FETCH ----------
function fetchSource(cfg, cacheKey, id, s, e, env = null) {
  const mod = SOURCE_MODULES[cfg.key];
  const tmdbKey = cfg.key === 'lookmovie' ? env?.TMDB_API_KEY : null;

  if (cfg.multiBase) {
    return withTimeout(
      jitter(cfg.jitter).then(async () => {
        for (const base of mod.BASES) {
          const key = `${cfg.key}-${base}-${cacheKey}`;
          const r = await getCached(key, () =>
            withRetry(() => mod.getStream(id, s, e, base), cfg.retries)
          );
          if (r) return r;
        }
        return null;
      }),
      cfg.timeout
    );
  }

  return withTimeout(
    jitter(cfg.jitter).then(() =>
      getCached(`${cfg.key}-${cacheKey}`, () =>
        withRetry(() => mod.getStream(id, s, e, tmdbKey), cfg.retries)
      )
    ),
    cfg.timeout
  );
}

// -------- ALL SOURCES ----------
async function getAllWorkingSources(id, s, e, env = null) {
  const cacheKey = `${id}-${s || ''}-${e || ''}`;

  const fetched = await Promise.all(
    SOURCES.filter(c => !c.disabled).map(cfg =>
      fetchSource(cfg, cacheKey, id, s, e, env)
        .then(r => ({ raw: r, source: cfg.key }))
        .catch(() => ({ raw: null, source: cfg.key }))
    )
  );

  const valid = fetched.filter(x => x.raw);

  return valid.map(c => {
    const cfg = SOURCE_MAP[c.source];

    return {
      source: c.source,
      label: cfg?.label || c.source,
      url: wrapUrl(c.raw, c.source)
    };
  });
}

// -------- MAIN API ----------
export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const q = Object.fromEntries(url.searchParams);

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json"
  };

  if (url.pathname === "/api/movie") {
    const { id } = q;
    if (!id) return new Response(JSON.stringify({ error: "missing id" }), { status: 400, headers: cors });

    const sources = await getAllWorkingSources(id, null, null, env);

    if (!sources.length)
      return new Response(JSON.stringify({ error: "no sources" }), { status: 502, headers: cors });

    return new Response(JSON.stringify({ sources }, null, 2), { headers: cors });
  }

  if (url.pathname === "/api/tv") {
    const { id, season, episode } = q;
    const sources = await getAllWorkingSources(id, season, episode, env);

    return new Response(JSON.stringify({ sources }, null, 2), { headers: cors });
  }

  return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: cors });
}
