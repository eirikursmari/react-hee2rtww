// Supabase Edge Function — Extraction Schema Builder
// Accepts a PDF or text document, calls Claude to generate new extraction
// dimensions, saves the updated schema to pipeline_config in Supabase.
//
// Secrets required (Supabase dashboard → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY
//   OPENAI_API_KEY        (injected automatically)
//   SUPABASE_URL          (injected automatically)
//   SUPABASE_SERVICE_ROLE_KEY (injected automatically)

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age":       "86400",
};

const BUILDER_SYSTEM = `You are a research metadata specialist helping to design extraction schemas for artistic research expositions on the Research Catalogue (researchcatalogue.net).

The user has uploaded a document describing a research framework, taxonomy, or methodology. Analyze it and propose new metadata dimensions to extract from exposition texts.

Each dimension should help classify and discover artistic research according to the framework in the document.

Return ONLY a valid JSON object with this exact structure — no prose, no markdown:
{
  "new_dimensions": [
    {
      "key": "snake_case_identifier",
      "label": "Human-Readable Label",
      "type": "array",
      "app_filter": true,
      "app_tip": "Short explanation shown to users in the filter UI",
      "prompt": "Instruction for the extraction model — what to look for and how to classify it",
      "values": ["value1", "value2", "value3"]
    }
  ],
  "summary": "2-3 sentence explanation of what new dimensions were added and why, based on the document"
}

Rules:
- "type" must be "array" (multiple values from a list) or "string" (free text)
- For "array" type, "values" is a controlled vocabulary (5-15 items); for "string" type, omit "values"
- "key" must be unique, snake_case, not already in the existing schema
- "app_filter" should be true if users would benefit from filtering by this dimension
- Keep "values" concise and mutually meaningful
- Only propose dimensions that are genuinely useful for finding artistic research
- If the document does not suggest useful new dimensions, return {"new_dimensions": [], "summary": "No new dimensions identified."}`;

const DEFAULT_SCHEMA = {
  version: "1.0",
  system_prompt: "You are a research analyst specialising in artistic research. Extract structured metadata from exposition texts for the Research Catalogue (researchcatalogue.net).\n\nReturn ONLY a valid JSON object — no prose, no markdown fences. Use null for fields where the information is not present. Be conservative: only include what is explicitly stated or clearly demonstrated in the text.",
  array_dimensions: [
    { key: "research_approach",      label: "Research Approach",      app_filter: true,  prompt: "Array of research approaches.",  values: ["practice-based","theoretical","collaborative","participatory","autoethnographic","speculative","performative","experimental","historical","comparative"] },
    { key: "artistic_medium",        label: "Artistic Medium",        app_filter: true,  prompt: "Array of artistic media.",         values: ["performance","sound","video","installation","painting","ceramics","drawing","photography","text","textile","sculpture","digital","architecture"] },
    { key: "methodological_framing", label: "Methodological Framing", app_filter: true,  prompt: "Array of methodological framings.", values: ["phenomenological","material","archival","ethnographic","process-based","embodied","relational","site-specific"] },
    { key: "geographic_context",     label: "Geographic Context",     app_filter: false, prompt: "Array of geographic contexts.",    values: [] },
    { key: "impact_types",           label: "Impact Type",            app_filter: true,  prompt: "Array of impact types.",           values: ["community engagement","cultural preservation","environmental","social justice","health and wellbeing","education","cross-cultural dialogue","public space","policy influence","economic"] },
  ],
  text_dimensions: [
    { key: "research_question" }, { key: "methods_described" }, { key: "key_findings" },
    { key: "materials_tools"  }, { key: "theoretical_refs"  }, { key: "impact_scope"  },
    { key: "impact_evidence_level" },
  ],
  nested_dimensions: {
    impact_potential: { fields: { beneficiaries: "", goals: "", applications: "" } },
    impact_actual:    { fields: { outcomes: "", communities: "", partnerships: "", policy_changes: "", public_engagement: "" } },
  },
  custom_dimensions: [],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method === "GET") {
    // Return the current schema from Supabase (used by the app to populate filter UI)
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const KEY          = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    try {
      const r = await fetch(
        SUPABASE_URL + "/rest/v1/pipeline_config?select=value&key=eq.extraction_schema",
        { headers: { apikey: KEY, Authorization: "Bearer " + KEY } }
      );
      const rows = r.ok ? await r.json() : [];
      const schema = rows[0]?.value ?? DEFAULT_SCHEMA;
      return Response.json({ schema }, { headers: CORS });
    } catch {
      return Response.json({ schema: DEFAULT_SCHEMA }, { headers: CORS });
    }
  }
  if (req.method !== "POST") {
    return Response.json({ error: "POST required" }, { status: 405, headers: CORS });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers: CORS });
  }

  // Generic config write — used by the app to save any key/value to pipeline_config
  if (body?.action === "save-config") {
    const authKey = req.headers.get("x-anthropic-key") ?? "";
    if (!authKey.startsWith("sk-ant-")) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers: CORS });
    }
    const { key, value } = body as { key: string; value: unknown };
    if (!key || value === undefined) {
      return Response.json({ error: "key and value required" }, { status: 400, headers: CORS });
    }
    const _URL = Deno.env.get("SUPABASE_URL")!;
    const _KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const _hdrs = { "Content-Type": "application/json", apikey: _KEY, Authorization: "Bearer " + _KEY };
    const r = await fetch(_URL + "/rest/v1/pipeline_config", {
      method: "POST",
      headers: { ..._hdrs, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      return Response.json({ error: (e as any).message ?? "Supabase error" }, { status: 500, headers: CORS });
    }
    return Response.json({ ok: true }, { headers: CORS });
  }

  const { document, filename = "document" } = body as {
    document: { type: string; content: string }; filename: string;
  };
  if (!document?.content?.trim()) {
    return Response.json({ error: "document.content is required" }, { status: 400, headers: CORS });
  }

  const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
  if (!ANTHROPIC_KEY) {
    return Response.json({ error: "ANTHROPIC_API_KEY secret not set in this edge function" }, { status: 500, headers: CORS });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const KEY          = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sbHeaders    = { "Content-Type": "application/json", apikey: KEY, Authorization: "Bearer " + KEY };

  try {
    // 1. Load current schema from Supabase (to know existing keys)
    const configRes = await fetch(
      SUPABASE_URL + "/rest/v1/pipeline_config?select=value&key=eq.extraction_schema",
      { headers: sbHeaders }
    );
    const configRows  = configRes.ok ? await configRes.json() : [];
    const currentSchema: typeof DEFAULT_SCHEMA = configRows[0]?.value ?? DEFAULT_SCHEMA;

    const existingKeys = [
      ...currentSchema.array_dimensions.map((d: any) => d.key),
      ...currentSchema.text_dimensions.map((d: any) => d.key),
      ...(currentSchema.custom_dimensions ?? []).map((d: any) => d.key),
    ].join(", ");

    // 2. Build Claude message — support PDF (base64) and plain text
    const userContent: unknown[] = [];
    if (document.type === "pdf") {
      userContent.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: document.content },
      });
    } else {
      userContent.push({ type: "text", text: `Document content:\n\n${document.content}` });
    }
    userContent.push({
      type: "text",
      text: `Filename: ${filename}\n\nExisting schema keys (do not duplicate): ${existingKeys}\n\nAnalyze the document and propose new extraction dimensions. Return ONLY valid JSON as specified.`,
    });

    // 3. Call Claude
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":   "application/json",
        "x-api-key":      ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        system:     BUILDER_SYSTEM,
        messages:   [{ role: "user", content: userContent }],
      }),
    });
    if (!claudeRes.ok) {
      const e = await claudeRes.json().catch(() => ({}));
      throw new Error("Claude " + claudeRes.status + ": " + (e.error?.message ?? claudeRes.statusText));
    }
    const claudeData = await claudeRes.json();
    let raw = claudeData.content[0].text.trim();
    if (raw.startsWith("```")) {
      const parts = raw.split("```");
      raw = parts[1].replace(/^json\s*/, "").trim();
    }
    const result = JSON.parse(raw);
    const newDimensions: any[] = result.new_dimensions ?? [];

    // 4. Merge new dimensions into schema
    const updatedSchema = {
      ...currentSchema,
      custom_dimensions: [
        ...(currentSchema.custom_dimensions ?? []),
        ...newDimensions,
      ],
    };

    // 5. Save updated schema to Supabase pipeline_config
    await fetch(SUPABASE_URL + "/rest/v1/pipeline_config", {
      method:  "POST",
      headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        key:        "extraction_schema",
        value:      updatedSchema,
        updated_at: new Date().toISOString(),
      }),
    });

    // 6. Build updated filter config and save it too
    const filterConfig = [
      ...updatedSchema.array_dimensions.filter((d: any) => d.app_filter),
      ...newDimensions.filter((d: any) => d.app_filter && d.type === "array"),
    ].map((d: any) => ({
      key:    d.key,
      label:  d.label,
      tip:    d.app_tip ?? "",
      values: d.values ?? [],
    }));

    await fetch(SUPABASE_URL + "/rest/v1/pipeline_config", {
      method:  "POST",
      headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        key:        "filter_config",
        value:      filterConfig,
        updated_at: new Date().toISOString(),
      }),
    });

    return Response.json({
      new_dimensions: newDimensions,
      summary:        result.summary ?? "",
      total_custom:   updatedSchema.custom_dimensions.length,
    }, { headers: CORS });

  } catch (err) {
    console.error(err);
    return Response.json({ error: err.message ?? "Internal error" }, { status: 500, headers: CORS });
  }
});
