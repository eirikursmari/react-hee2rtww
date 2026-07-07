// Supabase Edge Function — Multimodal media for an exposition
//
// Returns the stored per-image content (visual description + OCR'd text) from
// exposition_media, and re-harvests FRESH Research Catalogue thumbnail URLs on
// demand (the stored URLs carry short-lived signed tokens that expire). No
// media is re-hosted — fresh URLs are hotlinked, the same posture as the RC
// thumbnails the app already shows.
//
// POST { ids: number[] }   header: x-app-key: <APP_PASSPHRASE>
//   → { media: { [expoId]: [ { media_id, size, description, ocr_text, thumb_url } ] } }

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-app-key",
  "Access-Control-Max-Age":       "86400",
};

const SNAPSHOT = "https://map.rcdata.org/rcjson/expo/";
const VIEW     = "https://www.researchcatalogue.net/view/";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const IMG_EXT   = /\.(png|jpe?g|gif|webp)$/i;
const MEDIA_RE  = /https:\/\/media\.researchcatalogue\.net\/[^\s"'<>)]+/g;
const HASH_RE   = /\/([0-9a-f]{32})/;
const DIMS_RE   = /_(\d+)x(\d+)\.(?:png|jpe?g|gif|webp)/i;
const TARGET    = 1568;   // Claude/display sweet spot; RC serves up to 2048
const MAX_PAGES = 6;      // cap live page fetches per exposition

// Rank a size variant: maximise usable detail (min(longEdge, TARGET)), then
// prefer the smaller file. Unknown/original size ranks lowest.
function variantScore(url: string): [number, number] {
  const m = url.match(DIMS_RE);
  if (!m) return [0, 0];
  const longEdge = Math.max(+m[1], +m[2]);
  return [Math.min(longEdge, TARGET), -longEdge];
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&#38;/g, "&").replace(/&quot;/g, '"');
}

// Harvest fresh image URLs from the live exposition, keyed by content hash.
async function harvestFresh(expoId: number): Promise<Map<string, string>> {
  const byHash = new Map<string, string[]>();
  let pageIds: string[] = [];
  try {
    const snap = await fetch(SNAPSHOT + expoId, { headers: { Accept: "application/json" } });
    if (snap.ok) {
      const j = await snap.json();
      pageIds = j?.pages && typeof j.pages === "object" ? Object.keys(j.pages) : [];
    }
  } catch { /* snapshot down — return empty */ }

  for (const pid of pageIds.slice(0, MAX_PAGES)) {
    try {
      const r = await fetch(VIEW + expoId + "/" + pid,
        { headers: { "User-Agent": BROWSER_UA, "Referer": "https://www.researchcatalogue.net/" } });
      if (!r.ok) continue;
      const html = decodeEntities(await r.text());
      for (const u of html.match(MEDIA_RE) ?? []) {
        const path = u.split("?")[0];
        if (!IMG_EXT.test(path)) continue;
        const hm = u.match(HASH_RE);
        const key = hm ? hm[1] : path;
        (byHash.get(key) ?? byHash.set(key, []).get(key)!).push(u);
      }
    } catch { /* skip page */ }
  }

  // Best variant per hash; expose under both full hash and its 16-char prefix
  // (stored media_id is hash[:16]).
  const best = new Map<string, string>();
  for (const [hash, urls] of byHash) {
    let top = urls[0], topScore = variantScore(top);
    for (const u of urls) {
      const s = variantScore(u);
      if (s[0] > topScore[0] || (s[0] === topScore[0] && s[1] > topScore[1])) {
        top = u; topScore = s;
      }
    }
    best.set(hash, top);
    best.set(hash.slice(0, 16), top);
  }
  return best;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST")
    return Response.json({ error: "POST required" }, { status: 405, headers: CORS });

  const expected = Deno.env.get("APP_PASSPHRASE");
  if (!expected)
    return Response.json({ error: "APP_PASSPHRASE not set" }, { status: 500, headers: CORS });
  if (req.headers.get("x-app-key") !== expected)
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: CORS });

  let ids: number[];
  try {
    ({ ids } = await req.json());
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers: CORS });
  }
  ids = (ids ?? []).map(Number).filter((n) => Number.isFinite(n)).slice(0, 20);
  if (ids.length === 0) return Response.json({ media: {} }, { headers: CORS });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sbHeaders = { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY };

  // Stored per-image rows
  const rowsRes = await fetch(
    SUPABASE_URL + "/rest/v1/exposition_media?select=exposition_id,media_id,size," +
      "description,ocr_text,media_status&exposition_id=in.(" + ids.join(",") + ")" +
      "&order=exposition_id",
    { headers: sbHeaders },
  );
  const rows = rowsRes.ok ? await rowsRes.json() : [];

  // Fresh thumbnail URLs (one live harvest per exposition, in parallel)
  const freshByExpo = new Map<number, Map<string, string>>(
    await Promise.all(ids.map(async (id) =>
      [id, await harvestFresh(id)] as [number, Map<string, string>])),
  );

  const media: Record<number, any[]> = {};
  for (const r of rows) {
    const fresh = freshByExpo.get(r.exposition_id);
    (media[r.exposition_id] ??= []).push({
      media_id:    r.media_id,
      size:        r.size,
      description: r.description ?? "",
      ocr_text:    r.ocr_text ?? "",
      thumb_url:   fresh?.get(r.media_id) ?? fresh?.get((r.media_id ?? "").slice(0, 16)) ?? null,
    });
  }

  return Response.json({ media }, { headers: CORS });
});
