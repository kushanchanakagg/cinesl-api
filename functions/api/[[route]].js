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

const ALL_SOURCE_MODULES = { vidzee, vidnest, vidsrc, vidrock, videasy, cinesu, peachify, lookmovie, vidlink, vixsrc };

const SOURCE_MODULES = Object.fromEntries(
    Object.entries(ALL_SOURCE_MODULES).filter(([key]) => {
        const cfg = SOURCE_MAP[key];
        return cfg && !cfg.disabled;
    })
);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36";

function fetchUpstream(url, headers = {}) {
    return fetch(url, {
        headers: {
            "User-Agent": UA,
            "Referer": new URL(url).origin + "/",
            "Origin": new URL(url).origin,
            ...headers
        },
        redirect: "follow"
    });
}

function rewriteM3u8(body, url) {
    const base = url.split("?")[0];
    const dir = base.slice(0, base.lastIndexOf("/") + 1);
    const origin = new URL(url).origin;

    return body.split("\n").map(line => {
        const t = line.trim();
        if (!t) return line;

        if (t.startsWith("#")) {
            return t.replace(/URI="([^"]+)"/g, (m, uri) => {
                const abs = uri.startsWith("http")
                    ? uri
                    : uri.startsWith("/")
                        ? origin + uri
                        : dir + uri;

                return `URI="https://cdn.cinesl.top/proxy.php?url=${encodeURIComponent(abs)}"`;
            });
        }

        const abs = t.startsWith("http")
            ? t
            : t.startsWith("/")
                ? origin + t
                : dir + t;

        return `https://cdn.cinesl.top/proxy.php?url=${encodeURIComponent(abs)}`;
    }).join("\n");
}

export default {
    async fetch(request) {
        const url = new URL(request.url);
        const q = Object.fromEntries(url.searchParams);

        if (!q.url) {
            return new Response("Missing url", { status: 400 });
        }

        const rawUrl = decodeURIComponent(q.url);

        const isM3u8 = rawUrl.includes(".m3u8") || rawUrl.includes("playlist");

        try {
            const res = await fetchUpstream(rawUrl);
            const ct = res.headers.get("content-type") || "";

            if (isM3u8 || ct.includes("mpegurl")) {
                const text = await res.text();
                return new Response(rewriteM3u8(text, rawUrl), {
                    headers: {
                        "content-type": "application/vnd.apple.mpegurl",
                        "access-control-allow-origin": "*"
                    }
                });
            }

            return new Response(res.body, {
                headers: {
                    "content-type": ct,
                    "access-control-allow-origin": "*"
                }
            });

        } catch (e) {
            return new Response(e.message, { status: 500 });
        }
    }
};
