// Supabase Edge Function — Corpus Analytics
// Fetches all exposition metadata, computes aggregated statistics,
// then asks Claude to interpret them in response to a natural-language question.

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age":       "86400",
};

const FIELDS = "created_at,published_in,research_approach,artistic_medium," +
               "methodological_framing,impact_types,language";

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
  const extracted = rows.filter(r => Array.isArray(r.research_approach) && r.research_approach.length > 0).length;

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

  const langSection = dist(rows, "language").length > 0
    ? `\nLANGUAGE:\n${fmt(dist(rows, "language"), 20)}\n` : "";

  return `CORPUS: ${total} expositions (${extracted} with extracted metadata, ${total - extracted} pending)

PUBLISHED IN:\n${fmt(dist(rows, "published_in", true), 30)}

RESEARCH APPROACH:\n${fmt(dist(rows, "research_approach", true))}

ARTISTIC MEDIUM:\n${fmt(dist(rows, "artistic_medium", true))}

METHODOLOGICAL FRAMING:\n${fmt(dist(rows, "methodological_framing", true))}

IMPACT TYPES:\n${fmt(dist(rows, "impact_types", true))}
${langSection}
EXPOSITIONS BY YEAR:\n${yearStr}

IMPACT TYPES BY YEAR (top 5 per year):\n${impactTrend}

RESEARCH APPROACH BY JOURNAL (top 8 journals):\n${approachByJournal}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return Response.json({ error: "POST required" }, { status: 405, headers: CORS });

  let question: string, anthropicKey: string, model: string;
  try {
    ({ question, anthropicKey, model = "claude-sonnet-4-6" } = await req.json());
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers: CORS });
  }
  if (!question?.trim())    return Response.json({ error: "question is required"    }, { status: 400, headers: CORS });
  if (!anthropicKey?.trim()) return Response.json({ error: "anthropicKey is required" }, { status: 400, headers: CORS });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const KEY          = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sbHeaders    = { "Content-Type": "application/json", apikey: KEY, Authorization: "Bearer " + KEY };

  try {
    const rows  = await fetchAllExpositions(SUPABASE_URL, sbHeaders);
    const stats = buildStats(rows);

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
        system: `You are a research analyst specialising in artistic research. You have aggregated statistics from the Research Catalogue (researchcatalogue.net), a platform hosting artistic research expositions. Use the statistics to answer the user's question analytically. Be specific — cite counts and percentages. Identify trends and patterns. Format your answer clearly using markdown headings and lists. Where data is incomplete (e.g. only ${Math.round(rows.filter((r:any) => Array.isArray(r.research_approach) && r.research_approach.length).length / rows.length * 100)}% of expositions have extracted metadata), note the limitation.`,
        messages: [{ role: "user", content: `Statistics:\n\n${stats}\n\nQuestion: ${question}` }],
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
