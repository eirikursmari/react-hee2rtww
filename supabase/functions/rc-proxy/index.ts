// Supabase Edge Function — Research Catalogue Proxy
// Forwards whitelisted Research Catalogue requests so the browser can call
// RC endpoints that lack CORS headers, without a third-party proxy service.
//
// Usage: GET /rc-proxy?url=<encoded RC url>
// No secrets required.

const ALLOWED_PREFIXES = [
  "https://www.researchcatalogue.net/portal/search-result",
  "https://map.rcdata.org/rcjson/expo/",
];

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age":       "86400",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return Response.json({ error: "GET required" }, { status: 405, headers: CORS });

  const target = new URL(req.url).searchParams.get("url") ?? "";
  if (!ALLOWED_PREFIXES.some((p) => target.startsWith(p))) {
    return Response.json({ error: "URL not allowed" }, { status: 400, headers: CORS });
  }

  try {
    const res  = await fetch(target, { headers: { Accept: "application/json" } });
    const body = await res.text();
    return new Response(body, {
      status:  res.status,
      headers: { ...CORS, "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
    });
  } catch (err: any) {
    console.error(err);
    return Response.json({ error: err.message ?? "Proxy fetch failed" }, { status: 502, headers: CORS });
  }
});
