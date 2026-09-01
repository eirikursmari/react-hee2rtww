// Supabase Edge Function — Corpus Analytics
// Fetches all exposition metadata, computes aggregated statistics,
// then asks Claude to interpret them in response to a natural-language question.
//
// Secrets required (Supabase dashboard → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY   the shared Anthropic key
//   APP_PASSPHRASE      shared passphrase users enter once in app settings

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-app-key",
  "Access-Control-Max-Age":       "86400",
};

const FIELDS = "created_at,published_in,research_approach,artistic_medium," +
               "methodological_framing,geographic_context,impact_types," +
               "impact_evidence_level,impact_scope_domain,research_themes,relevance_reach,language," +
               "custom_metadata,unavailable";

async function fetchAllExpositions(supabaseUrl: string, headers: Record<string, string>) {
  const PAGE = 1000;
  let all: any[] = [];
  let from = 0;
  while (true) {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/expositions?select=${FIELDS}&order=id`,
      { headers: { ...headers, Range: `${from}-${from + PAGE - 1}`, "Range-Unit": "items" } }
    );
    if (!res.ok) break;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    all = all.concat(rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

function dist(rows: any[], key: string, isArray = false): [string, number][] {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const v = row[key];
    if (!v) continue;
    const vals = isArray ? (Array.isArray(v) ? v : []) : [String(v)];
    for (const x of vals) if (x) counts[x] = (counts[x] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

function extractYear(s: string): string | null {
  if (!s) return null;
  const m = s.match(/(\d{4})/);
  return m ? m[1] : null;
}

function fmt(data: [string, number][], n = 20): string {
  return data.slice(0, n).map(([k, v]) => `  ${k}: ${v}`).join("\n");
}

function buildStats(rows: any[]): string {
  const total = rows.length;
  const hasMeta = (r: any) => Array.isArray(r.research_approach) && r.research_approach.length > 0;
  const extracted   = rows.filter(hasMeta).length;
  const unavailable = rows.filter(r => r.unavailable && !hasMeta(r)).length;
  const pending     = total - extracted - unavailable;

  // Aurora SDG labels live under custom_metadata.sdg_labels — flatten to a
  // top-level field so dist()/cross-tab helpers can aggregate them.
  for (const r of rows) {
    r._sdg = Array.isArray(r.custom_metadata?.sdg_labels) ? r.custom_metadata.sdg_labels : [];
  }
  const sdgTagged = rows.filter((r) => r._sdg.length > 0).length;

  // Year counts
  const yearMap: Record<string, number> = {};
  for (const r of rows) {
    const y = extractYear(r.created_at || "");
    if (y) yearMap[y] = (yearMap[y] || 0) + 1;
  }
  const yearStr = Object.entries(yearMap).sort().map(([y, c]) => `  ${y}: ${c}`).join("\n");

  // Impact types by year (trend)
  const byYear: Record<string, any[]> = {};
  for (const r of rows) {
    const y = extractYear(r.created_at || "");
    if (y) { if (!byYear[y]) byYear[y] = []; byYear[y].push(r); }
  }
  const impactTrend = Object.entries(byYear).sort()
    .map(([y, rs]) => {
      const top = dist(rs, "impact_types", true).slice(0, 5).map(([k, v]) => `${k}(${v})`).join(", ");
      return `  ${y}: ${top || "—"}`;
    }).join("\n");

  // Research approach by journal (top 8 journals)
  const topJournals = dist(rows, "published_in", true).slice(0, 8).map(([k]) => k);
  const approachByJournal = topJournals.map(j => {
    const jRows = rows.filter(r => Array.isArray(r.published_in) && r.published_in.includes(j));
    const top = dist(jRows, "research_approach", true).slice(0, 5).map(([k, v]) => `${k}(${v})`).join(", ");
    return `  ${j}: ${top || "—"}`;
  }).join("\n");

  // Research themes by journal (relevance axis; peer-reviewed only)
  const themesByJournal = topJournals.map(j => {
    const jRows = rows.filter(r => Array.isArray(r.published_in) && r.published_in.includes(j));
    const top = dist(jRows, "research_themes", true).slice(0, 6).map(([k, v]) => `${k}(${v})`).join(", ");
    return `  ${j}: ${top || "—"}`;
  }).join("\n");

  // Peer-reviewed base for the v2.4 relevance/impact dims (only these carry
  // research_themes), so the model can state the right denominator.
  const themed = rows.filter((r) => Array.isArray(r.research_themes) && r.research_themes.length > 0).length;

  // SDG by year and by journal (same cross-tab shape as the impact/approach ones)
  const sdgTrend = Object.entries(byYear).sort()
    .map(([y, rs]) => {
      const top = dist(rs, "_sdg", true).slice(0, 5).map(([k, v]) => `${k}(${v})`).join(", ");
      return `  ${y}: ${top || "—"}`;
    }).join("\n");

  const sdgByJournal = topJournals.map(j => {
    const jRows = rows.filter(r => Array.isArray(r.published_in) && r.published_in.includes(j));
    const top = dist(jRows, "_sdg", true).slice(0, 5).map(([k, v]) => `${k}(${v})`).join(", ");
    return `  ${j}: ${top || "—"}`;
  }).join("\n");

  const langSection = dist(rows, "language").length > 0
    ? `\nLANGUAGE:\n${fmt(dist(rows, "language"), 20)}\n` : "";

  return `CORPUS: ${total} expositions (${extracted} with extracted metadata, ${unavailable} no longer available on RC so unextractable, ${pending} pending extraction)

PUBLISHED IN:\n${fmt(dist(rows, "published_in", true), 30)}

RESEARCH APPROACH:\n${fmt(dist(rows, "research_approach", true))}

ARTISTIC MEDIUM:\n${fmt(dist(rows, "artistic_medium", true))}

METHODOLOGICAL FRAMING:\n${fmt(dist(rows, "methodological_framing", true))}

IMPACT TYPES (whole corpus; see SCOPE NOTE):\n${fmt(dist(rows, "impact_types", true))}

RESEARCH THEMES — relevance axis, artistic-research concerns (${themed} peer-reviewed expositions; multi-label, so counts exceed that total):\n${fmt(dist(rows, "research_themes", true), 20)}

RELEVANCE REACH (peer-reviewed; single value each):\n${fmt(dist(rows, "relevance_reach", true))}

IMPACT EVIDENCE LEVEL (peer-reviewed):\n${fmt(dist(rows, "impact_evidence_level", true))}

IMPACT SCOPE — DOMAIN (peer-reviewed):\n${fmt(dist(rows, "impact_scope_domain", true))}

SDG LABELS — Aurora classifier (${sdgTagged} of ${total} expositions carry ≥1 goal; multi-label, so counts exceed that total):\n${fmt(dist(rows, "_sdg", true), 20)}
${langSection}
SCOPE NOTE: research_themes, relevance_reach, impact_evidence_level and impact_scope_domain come from the v2.4 extraction and exist ONLY for the ${themed} peer-reviewed expositions. impact_types is populated corpus-wide (~${dist(rows, "impact_types", true).reduce((s, [, v]) => s + v, 0)} tags) from an older run, so it sits on a much larger base — never compare its raw counts directly against the peer-reviewed-only dimensions; use the matching denominator for each.

EXPOSITIONS BY YEAR:\n${yearStr}

IMPACT TYPES BY YEAR (top 5 per year):\n${impactTrend}

SDG BY YEAR (top 5 per year):\n${sdgTrend}

RESEARCH APPROACH BY JOURNAL (top 8 journals):\n${approachByJournal}

RESEARCH THEMES BY JOURNAL (top 6 themes per top journal; peer-reviewed):\n${themesByJournal}

SDG BY JOURNAL (top 5 per top journal):\n${sdgByJournal}`;
}

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

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const KEY          = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sbHeaders    = { "Content-Type": "application/json", apikey: KEY, Authorization: "Bearer " + KEY };

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers: CORS });
  }

  // Data mode — return the raw metadata rows for the client-side visual
  // explorer (charts). No Anthropic call, no question required.
  if (body?.mode === "data") {
    try {
      const rows = await fetchAllExpositions(SUPABASE_URL, sbHeaders);
      return Response.json({ rows, total: rows.length }, { headers: CORS });
    } catch (err: any) {
      return Response.json({ error: err.message ?? "Internal error" }, { status: 500, headers: CORS });
    }
  }

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    return Response.json({ error: "ANTHROPIC_API_KEY secret not set in this edge function" }, { status: 500, headers: CORS });
  }

  const question = (body?.question as string) || "";
  const model    = (body?.model as string) || "claude-sonnet-4-6";
  const history  = (body?.history as { q: string; a: string }[]) || [];
  if (!question?.trim()) return Response.json({ error: "question is required" }, { status: 400, headers: CORS });

  try {
    const rows  = await fetchAllExpositions(SUPABASE_URL, sbHeaders);
    const stats = buildStats(rows);

    // Build messages — stats appear only in the first user message to avoid
    // repeating them for every follow-up (saves tokens, keeps context clean)
    const firstQ = history.length > 0 ? history[0].q : question;
    const messages: { role: string; content: string }[] = [
      { role: "user", content: `Statistics:\n\n${stats}\n\nQuestion: ${firstQ}` },
    ];
    if (history.length > 0) {
      messages.push({ role: "assistant", content: history[0].a });
      for (let i = 1; i < history.length; i++) {
        messages.push({ role: "user",      content: history[i].q });
        messages.push({ role: "assistant", content: history[i].a });
      }
      messages.push({ role: "user", content: question });
    }

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system: `You are a research analyst specialising in artistic research. You have aggregated statistics from the Research Catalogue (researchcatalogue.net), a platform hosting artistic research expositions. Use the statistics to answer the user's question analytically. Be specific — cite counts and percentages. Identify trends and patterns. Format your answer clearly using markdown headings and lists. Where data is incomplete (e.g. only ${Math.round(rows.filter((r:any) => Array.isArray(r.research_approach) && r.research_approach.length).length / rows.length * 100)}% of expositions have extracted metadata), note the limitation. This is a conversation — build on your previous answers when relevant.`,
        messages,
      }),
    });

    if (!claudeRes.ok) {
      const e = await claudeRes.json().catch(() => ({}));
      throw new Error("Claude " + claudeRes.status + ": " + (e.error?.message ?? claudeRes.statusText));
    }

    const answer = (await claudeRes.json()).content[0].text;
    return Response.json({ answer, total: rows.length }, { headers: CORS });

  } catch (err: any) {
    console.error(err);
    return Response.json({ error: err.message ?? "Internal error" }, { status: 500, headers: CORS });
  }
});
