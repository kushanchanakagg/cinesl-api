import {
  SOURCES,
  SOURCE_MAP,
  ALLOWED_ORIGINS,
  HEALTH_PROBE_ID,
  CACHE_TTL
} from '../../config.js';

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
  vidzee, vidnest, vidsrc, vidrock,
  videasy, cinesu, peachify, lookmovie,
  vidlink, vixsrc
};

const SOURCE_MODULES = Object.fromEntries(
  Object.entries(ALL_SOURCE_MODULES).filter(([key]) => {
    const cfg = SOURCE_MAP[key];
    return cfg && !cfg.disabled;
  })
);

const UA_LIST = [
  'Mozilla/5.0 Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 Safari/605.1.15',
  'Mozilla/5.0 Firefox/125.0'
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

function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise(r => setTimeout(() => r(null), ms))
  ]);
}

async function fetchUpstream(url, extra = {}, redirectCount = 0) {
  if (redirectCount > 5) return null;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': getUA(),
      'Accept': '*/*',
      'Referer': url,
      'Origin': new URL(url).origin,
      ...extra
    },
    redirect: 'manual'
  });

  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    const next = new URL(res.headers.get('location'), url).href;
    return fetchUpstream(next, extra, redirectCount + 1);
  }

  return res;
}

function rewriteM3u8(text, baseUrl) {
  const url = new URL(baseUrl);
  const origin = url.origin;
  const dir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);

  const toAbs = (u) => {
    if (u.startsWith('http')) return u;
    if (u.startsWith('/')) return origin + u;
    return dir + u;
  };

  return text.split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;

    if (t.startsWith('#')) {
      return t.replace(/URI="([^"]+)"/g, (_, u) => {
        const abs = toAbs(u);
        return `URI="/?url=${encodeURIComponent(abs)}"`;
      });
    }

    return `/?url=${encodeURIComponent(toAbs(t))}`;
  }).join('\n');
}

async function fetchSource(cfg, cacheKey, id, s, e, env) {
  const mod = SOURCE_MODULES[cfg.key];
  const tmdbKey = cfg.key === 'lookmovie' ? env?.TMDB_API_KEY : null;

  return withTimeout(
    jitter(cfg.jitter || 200).then(() =>
      getCached(`${cfg.key}-${cacheKey}`, () =>
        mod.getStream(id, s, e, tmdbKey)
      )
    ),
    cfg.timeout
  );
}

function wrapUrl(url, key) {
  if (!url) return null;
  const raw = typeof url === 'object' ? url.url : url;
  const cfg = SOURCE_MAP[key];

  if (!cfg || cfg.skipProxy) return raw;

  return `/?url=${encodeURIComponent(raw)}&src=${key}`;
}

async function verify(raw, key) {
  const mod = SOURCE_MODULES[key];
  if (!mod?.VERIFY_HEADERS) return true;

  try {
    const res = await fetch(raw, {
      headers: { 'User-Agent': getUA(), ...mod.VERIFY_HEADERS }
    });

    if (!res.ok) return false;

    const txt = await res.text();
    return txt.includes('#EXTM3U');
  } catch {
    return false;
  }
}

async function getAllWorkingSources(id, s, e, env) {
  const cacheKey = `${id}-${s || ''}-${e || ''}`;

  const results = await Promise.all(
    SOURCES.filter(c => !c.disabled).map(cfg =>
      fetchSource(cfg, cacheKey, id, s, e, env)
        .then(r => ({ r, key: cfg.key }))
        .catch(() => ({ r: null, key: cfg.key }))
    )
  );

  const valid = results.filter(x => x.r);

  const verified = await Promise.all(
    valid.map(async x => {
      const raw = typeof x.r === 'object' ? x.r.url : x.r;
      const ok = await verify(raw, x.key);
      if (!ok) return null;

      const cfg = SOURCE_MAP[x.key];

      return {
        source: x.key,
        label: cfg?.label || x.key,
        url: wrapUrl(raw, x.key)
      };
    })
  );

  return verified.filter(Boolean);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const q = Object.fromEntries(url.searchParams);

    // ======================
    // PROXY CORE
    // ======================
    if (q.url) {
      const target = decodeURIComponent(q.url);

      try {
        const res = await fetchUpstream(target);

        if (!res) return new Response('failed', { status: 502 });

        const ct = res.headers.get('content-type') || '';

        const isM3u8 =
          ct.includes('mpegurl') ||
          /\.m3u8/i.test(target);

        if (isM3u8) {
          const text = await res.text();
          return new Response(rewriteM3u8(text, target), {
            headers: {
              'Content-Type': 'application/vnd.apple.mpegurl',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        return new Response(res.body, {
          headers: {
            'Content-Type': ct || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Accept-Ranges': 'bytes'
          }
        });

      } catch (e) {
        return new Response(e.message, { status: 502 });
      }
    }

    // ======================
    // MOVIE API
    // ======================
    if (url.pathname === '/api/movie') {
      const { id } = q;
      if (!id) return Response.json({ error: 'missing id' }, { status: 400 });

      const sources = await getAllWorkingSources(id, null, null, env);

      if (!sources.length) {
        return Response.json({ error: 'no sources' }, { status: 502 });
      }

      return Response.json({ sources });
    }

    // ======================
    // TV API
    // ======================
    if (url.pathname === '/api/tv') {
      const { id, season, episode } = q;

      if (!id || !season || !episode) {
        return Response.json({ error: 'missing params' }, { status: 400 });
      }

      const sources = await getAllWorkingSources(id, season, episode, env);

      return Response.json({ sources });
    }

    return Response.json({ error: 'not found' }, { status: 404 });
  }
};
