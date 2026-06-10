// Supabase Edge Function — Claude Proxy
// Forwards chat requests to the Anthropic API using a server-stored key,
// so app users need no Anthropic key of their own.
//
// Secrets required (Supabase dashboard → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY   the shared Anthropic key
//   APP_PASSPHRASE      shared passphrase users enter once in app settings

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-app-key",
  "Access-Control-Max-Age":       "86400",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return Response.json({ error: "POST required" }, { status: 405, headers: CORS });

  const expected = Deno.env.get("APP_PASSPHRASE");
  if (!expected) {
    return Response.json({ error: "APP_PASSPHRASE secret not set in this edge function" }, { status: 500, headers: CORS });
  }
  if (req.headers.get("x-app-key") !== expected) {
    return Response.json({ error: "Unauthorized — check the access passphrase in ⚙ settings" }, { status: 401, headers: CORS });
  }

  const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  if (!ANTHROPIC_KEY) {
    return Response.json({ error: "ANTHROPIC_API_KEY secret not set in this edge function" }, { status: 500, headers: CORS });
  }

  let body: { model?: string; max_tokens?: number; system?: string; messages?: unknown[] };
  try { body = await req.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers: CORS });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return Response.json({ error: "messages is required" }, { status: 400, headers: CORS });
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      body.model ?? "claude-sonnet-4-6",
        max_tokens: Math.min(body.max_tokens ?? 4096, 8192),
        system:     body.system,
        messages:   body.messages,
      }),
    });
    // Pass status + body through unchanged so the client's overload-retry
    // logic keeps working.
    const data = await res.json().catch(() => ({}));
    return Response.json(data, { status: res.status, headers: CORS });
  } catch (err: any) {
    console.error(err);
    return Response.json({ error: err.message ?? "Internal error" }, { status: 500, headers: CORS });
  }
});
