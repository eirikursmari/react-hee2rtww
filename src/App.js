import React, { useState, useCallback, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import "./style.css";

const RC_SEARCH_URL  = "https://www.researchcatalogue.net/portal/search-result";
const RC_CONTENT_URL = "https://map.rcdata.org/rcjson/expo";
const CORS_PROXY     = "https://corsproxy.io/?";

const MODELS = [
  { id: "claude-haiku-4-5-20251001", label: "Haiku",  note: "fastest · lowest cost" },
  { id: "claude-sonnet-4-6",         label: "Sonnet", note: "balanced"              },
  { id: "claude-opus-4-7",           label: "Opus",   note: "most capable"         },
];
const DEEP_LIMIT     = 5;
const DEEP_TEXT_MAX  = 2500;
const EXPO_TEXT_MAX  = 8000;

// ── Network helpers ───────────────────────────────────────────────────────────

// All edge functions live next to each other; derive a sibling function's URL
// from the configured semantic search URL.
function siblingFnUrl(semanticUrl, name) {
  return semanticUrl.replace(/^[<\s]+|[>\s]+$/g, "").replace(/\/[^/]+$/, "/" + name);
}

function isCorsError(e) {
  return ["Failed to fetch", "NetworkError", "Load failed", "Network request failed"]
    .some(msg => e.message.includes(msg));
}

async function proxiedFetch(url) {
  try {
    return await fetch(url);
  } catch (e) {
    if (!isCorsError(e)) throw e;
    const semanticUrl = localStorage.getItem("rc_semantic_url") || "";
    const proxied = semanticUrl
      ? `${siblingFnUrl(semanticUrl, "rc-proxy")}?url=${encodeURIComponent(url)}`
      : `${CORS_PROXY}${encodeURIComponent(url)}`;
    return fetch(proxied);
  }
}

// ── Search functions ──────────────────────────────────────────────────────────

async function fetchKeywordResults(query) {
  const params = new URLSearchParams({
    fulltext: query, statuses: "published",
    type: "exposition", format: "json", page: "0",
  });
  const res = await proxiedFetch(`${RC_SEARCH_URL}?${params}`);
  if (!res.ok) throw new Error(`RC search returned ${res.status}`);
  const data = await res.json();
  if (Array.isArray(data)) return data;
  return data.expositions ?? data.results ?? [];
}

async function fetchSemanticResults(rawUrl, query, limit = 10, filters = {}, customCategories = []) {
  const apiUrl = rawUrl.replace(/^[<\s]+|[>\s]+$/g, "");
  const activeFilters = Object.fromEntries(
    Object.entries(filters).filter(([, v]) => Array.isArray(v) && v.length > 0)
  );
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit, filters: activeFilters, customCategories }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    const detail = parsed.error || body.slice(0, 200) || res.statusText;
    throw new Error(`Semantic search ${res.status} (${res.url}): ${detail}`);
  }
  const data = await res.json();
  return data.results ?? [];
}

async function fetchExpositionContent(id) {
  const res = await proxiedFetch(`${RC_CONTENT_URL}/${id}`);
  if (!res.ok) throw new Error(`Content fetch returned ${res.status}`);
  return res.json();
}

// ── Text helpers ──────────────────────────────────────────────────────────────

function stripHtml(html) {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = html;
  return (div.textContent || div.innerText || "").replace(/\s+/g, " ").trim();
}

function extractText(data) {
  const pages = data?.pages ?? {};
  const texts = [];
  const items = typeof pages === "object" && !Array.isArray(pages)
    ? Object.values(pages) : (Array.isArray(pages) ? pages : []);
  for (const page of items) {
    const tools = (page.tools && typeof page.tools === "object") ? page.tools : page;
    for (const type of ["tool-text", "tool-simpletext"]) {
      for (const tool of tools[type] ?? []) {
        const t = stripHtml(tool.content ?? "");
        if (t) texts.push(t);
      }
    }
  }
  return texts.join("\n\n");
}

function getAuthorName(exp) {
  const a = exp.author;
  if (!a) return "Unknown";
  if (typeof a === "string") return a;
  if (a.name) return a.name;
  if (a.firstName) return `${a.firstName} ${a.lastName || ""}`.trim();
  return "Unknown";
}

function getKeywords(exp) {
  const kw = exp.keywords;
  if (!kw) return [];
  if (Array.isArray(kw)) return kw;
  if (typeof kw === "string") return kw.split(/[,;]+/).map(k => k.trim()).filter(Boolean);
  return [];
}

function getExpositionUrl(exp) {
  if (exp.url) return exp.url;
  if (exp["exposition-url"]) return exp["exposition-url"];
  const id = exp.id ?? "";
  const pid = exp["default-page"]?.id ?? exp.defaultPage?.id ?? exp["default_page"]?.id ?? "";
  if (id && pid) return `https://www.researchcatalogue.net/view/${id}/${pid}`;
  if (id) return `https://www.researchcatalogue.net/view/${id}`;
  return "https://www.researchcatalogue.net";
}

function setsEqual(a, b) {
  if (!b || a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

// ── Context building for Claude ───────────────────────────────────────────────

function buildContext(expositions, contentMap = {}) {
  const limit = Object.keys(contentMap).length > 0 ? DEEP_LIMIT : 10;
  return expositions.slice(0, limit).map((exp, i) => {
    const author   = getAuthorName(exp);
    const kws      = getKeywords(exp).slice(0, 8).join(", ");
    const abs      = (exp.abstract || exp.description || "").slice(0, 300);
    const bodyText = contentMap[exp.id] || exp.matchedText || "";
    return [
      `[${i + 1}] "${exp.title || "Untitled"}" — ${author}`,
      exp.created ? `Published: ${exp.created}` : "",
      kws  ? `Keywords: ${kws}` : "",
      abs  ? `Abstract: ${abs}` : "",
      bodyText
        ? `Relevant content:\n${bodyText.slice(0, DEEP_TEXT_MAX)}${bodyText.length > DEEP_TEXT_MAX ? "…" : ""}`
        : "",
      `URL: ${getExpositionUrl(exp)}`,
    ].filter(Boolean).join("\n");
  }).join("\n\n---\n\n");
}

// ── Claude calls ──────────────────────────────────────────────────────────────
// Routed through the `claude` edge function — the Anthropic key lives
// server-side; the client only sends the shared access passphrase.

async function claudePost(body, auth, onRetry) {
  if (!auth.semanticUrl) {
    throw new Error("API URL not set — open ⚙ settings and enter the Supabase edge function URL.");
  }
  const RETRIES = 3;
  const DELAYS  = [3000, 6000, 12000];
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const res = await fetch(siblingFnUrl(auth.semanticUrl, "claude"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-app-key": auth.appKey,
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const err = await res.json().catch(() => ({}));
    const isOverloaded = res.status === 529 ||
      (err.error?.type === "overloaded_error") ||
      (err.error?.message || "").toLowerCase().includes("overload");
    if (isOverloaded && attempt < RETRIES) {
      const wait = DELAYS[attempt];
      if (onRetry) onRetry(attempt + 1, RETRIES, wait);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    throw new Error(err.error?.message || `Claude API error (${res.status})`);
  }
}

async function generateRAGAnswer(auth, query, context, isSemantic, modelId, onRetry) {
  const data = await claudePost({
    model: modelId,
    max_tokens: 4096,
    system: `You are a knowledgeable research assistant for the Research Catalogue (researchcatalogue.net), an international database for artistic research maintained by the Society for Artistic Research.

When answering, cite retrieved expositions by their bracket number [N]. Be concise and insightful; highlight connections between works when relevant.${isSemantic ? " Results were retrieved by semantic similarity — you may find content beyond the abstract that speaks directly to the query." : ""}`,
    messages: [{
      role: "user",
      content: `Query: "${query}"\n\nRetrieved expositions:\n\n${context}\n\nAnswer the query based on these expositions, citing them by [number].`,
    }],
  }, auth, onRetry);
  return data.content?.[0]?.text ?? "";
}

// Conversational query — history is [{q, a}, ...], systemCtx is the full exposition content
async function callClaudeConversation(auth, systemCtx, history, question, modelId, onRetry) {
  const messages = [
    ...history.flatMap(({ q, a }) => [
      { role: "user",      content: q },
      { role: "assistant", content: a },
    ]),
    { role: "user", content: question },
  ];
  const data = await claudePost({
    model: modelId,
    max_tokens: 4096,
    system: `You are a research assistant with access to the full text of selected expositions from the Research Catalogue (researchcatalogue.net). Answer questions about these specific works in detail, citing each exposition by its bracket number [N]. Be thorough and analytical — the full content is available to you. This is a conversation, so build on your previous answers when relevant.\n\nExposition content:\n\n${systemCtx}`,
    messages,
  }, auth, onRetry);
  return data.content?.[0]?.text ?? "";
}

// ── Components ────────────────────────────────────────────────────────────────

function ExpositionCard({ exp, index, semantic, selected, onToggle }) {
  const author   = getAuthorName(exp);
  const keywords = getKeywords(exp);
  const abstract = exp.abstract || exp.description || "";
  const url      = getExpositionUrl(exp);
  const thumb    = exp.thumbnail || exp["default-page"]?.screenshot || exp.screenshot;

  return (
    <article className={`exp-card${selected ? " exp-card-selected" : ""}`}>
      <label className="exp-checkbox" title={selected ? "Deselect" : "Select for detailed query"}>
        <input type="checkbox" checked={selected} onChange={() => onToggle(exp.id)} />
      </label>
      <span className="exp-index">[{index + 1}]</span>
      {thumb && (
        <div className="exp-thumb-wrap">
          <img className="exp-thumb" src={thumb} alt="" loading="lazy" />
        </div>
      )}
      <div className="exp-body">
        <a className="exp-title" href={url} target="_blank" rel="noopener noreferrer">
          {exp.title || "Untitled"}
        </a>
        <div className="exp-meta">
          {author}
          {exp.created && <> · <time>{exp.created}</time></>}
          {semantic && exp.similarity != null && (
            <span className="similarity-badge">
              {Math.round(exp.similarity * 100)}% match
            </span>
          )}
        </div>
        {abstract && (
          <p className="exp-abstract">
            {abstract.length > 240 ? abstract.slice(0, 240) + "…" : abstract}
          </p>
        )}
        {semantic && exp.matchedText && (
          <p className="exp-matched">
            <span className="matched-label">Matched: </span>
            {exp.matchedText.length > 200
              ? exp.matchedText.slice(0, 200) + "…"
              : exp.matchedText}
          </p>
        )}
        {keywords.length > 0 && (
          <div className="exp-keywords">
            {keywords.slice(0, 7).map((kw, i) => (
              <span className="kw-tag" key={i}>{kw}</span>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

function downloadMarkdown(filename, content) {
  const blob = new Blob([content], { type: "text/markdown" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function AnswerPanel({ label = "AI Answer", answer, loading, loadingMsg, error, onDownload }) {
  if (!loading && !loadingMsg && !error && !answer) return null;
  return (
    <section className="answer-section">
      <div className="answer-header">
        <h2 className="section-label">{label}</h2>
        {answer && onDownload && (
          <button className="download-btn" onClick={onDownload} title="Download as Markdown file">
            ↓ Download
          </button>
        )}
      </div>
      {loadingMsg && <p className="answer-loading">{loadingMsg}</p>}
      {loading && !loadingMsg && <p className="answer-loading">Generating answer…</p>}
      {error && <p className="answer-error">{error}</p>}
      {answer && <div className="answer-body"><ReactMarkdown>{answer}</ReactMarkdown></div>}
    </section>
  );
}

const FILTER_OPTIONS = [
  { label: "Research Approach", key: "research_approach",
    tip: "How the artist approaches the research process. 'Practice-based' means the art-making itself is the research method.",
    values: [
      "practice-based", "theoretical", "collaborative", "participatory",
      "autoethnographic", "speculative", "performative", "experimental",
      "historical", "comparative",
    ]},
  { label: "Artistic Medium", key: "artistic_medium",
    tip: "The primary material, form, or medium of the work.",
    values: [
      "performance", "sound", "video", "installation", "painting",
      "ceramics", "drawing", "photography", "text", "textile",
      "sculpture", "digital", "architecture",
    ]},
  { label: "Methodological Framing", key: "methodological_framing",
    tip: "The theoretical or philosophical lens through which the research is framed.",
    values: [
      "phenomenological", "material", "archival", "ethnographic",
      "process-based", "embodied", "relational", "site-specific",
    ]},
  { label: "Impact Type", key: "impact_types",
    tip: "Documented or intended societal impact beyond the immediate research context.",
    values: [
      "community engagement", "cultural preservation", "environmental",
      "social justice", "health and wellbeing", "education",
      "cross-cultural dialogue", "public space", "policy influence", "economic",
    ]},
  { label: "Published In", key: "published_in",
    tip: "The RC portal or journal where the exposition was published.",
    values: [
      "Research Catalogue",
      "Journal for Artistic Research",
      "RUUKKU - Studies in Artistic Research",
      "Journal of Sonic Studies",
      "VIS - Nordic Journal for Artistic Research",
      "HUB - Journal of Research in Art, Design and Society",
      "ArteActa – Journal for Performing Arts and Artistic Research",
      "ARJAZZ - Journal for Artistic Research in Jazz",
      "KC Research Portal",
      "Royal Academy of Art, The Hague",
      "Stockholm University of the Arts (SKH)",
      "Norwegian Academy of Music",
      "Codarts",
      "University of the Arts Helsinki",
      "University of Applied Arts Vienna",
      "Faculty of Fine Art, Music and Design, University of Bergen",
      "University of Agder, Faculty of Fine Arts",
      "Rhythmic Music Conservatory, Copenhagen",
      "Birmingham City University",
      "i2ADS - Research Institute in Art, Design and Society",
      "Norwegian Artistic Research Programme",
      "University of Inland Norway",
      "FFA BUT – Faculty of Fine Arts, Brno University of Technology",
      "Fontys Academy of the Arts",
      "Norwegian University of Science and Technology",
      "Academy of Creative and Performing Arts",
      "Konstfack - University of Arts, Crafts and Design",
      "University of Stavanger",
      "Aalto University",
      "Academy of Fine Arts Vienna",
      "International Center for Knowledge in the Arts (Denmark)",
      "Iceland University of the Arts",
      "KTH Royal Institute of Technology",
      "mdw - University of Music and Performing Arts Vienna",
      "Royal Irish Academy of Music",
      "Brera Academy of Fine Arts",
      "National Film School of Denmark",
      "The Danish National School of Performing Arts",
      "SAR Conference 2020",
      "NMH Student Portal",
    ]},
];

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [query,       setQuery]       = useState("");
  const [appKey,      setAppKey]      = useState(() => localStorage.getItem("rc_app_key")       || "");
  const [semanticUrl, setSemanticUrl] = useState(() => localStorage.getItem("rc_semantic_url")  || "");
  const [showSettings,setShowSettings]= useState(false);
  const [deepSearch,       setDeepSearch]       = useState(() => localStorage.getItem("rc_deep_search") === "1");
  const [useSemanticSearch,setUseSemanticSearch] = useState(() => localStorage.getItem("rc_use_semantic") !== "0");
  const [resultLimit,      setResultLimit]       = useState(() => Number(localStorage.getItem("rc_result_limit")) || 10);
  const [modelId,          setModelId]           = useState(() => localStorage.getItem("rc_model") || "claude-sonnet-4-6");
  const [filters,          setFilters]           = useState({});
  const [analyticsQ,            setAnalyticsQ]            = useState("");
  const [analyticsConversation, setAnalyticsConversation] = useState([]);
  const [analyticsLoading,      setAnalyticsLoading]      = useState(false);
  const [analyticsError,        setAnalyticsError]        = useState("");
  const [corpusTotal,           setCorpusTotal]           = useState(null);
  const analyticsEndRef = useRef(null);

  const [activeTab, setActiveTab] = useState(() => {
    const hasUrl = !!localStorage.getItem("rc_semantic_url");
    const useSemantic = localStorage.getItem("rc_use_semantic") !== "0";
    return hasUrl && useSemantic ? "semantic" : "keyword";
  });
  const [showInfoKeyword,   setShowInfoKeyword]   = useState(false);
  const [showInfoSemantic,  setShowInfoSemantic]  = useState(false);
  const [showInfoAnalytics, setShowInfoAnalytics] = useState(false);
  const [savedCategories,  setSavedCategories]   = useState(() => {
    try { return JSON.parse(localStorage.getItem("rc_categories") || "[]"); } catch { return []; }
  });
  const [newCatName,       setNewCatName]        = useState("");
  const [filterOptions,    setFilterOptions]     = useState(FILTER_OPTIONS);

  // Custom semantic categories
  const [customCats,          setCustomCats]          = useState(() => {
    try { return JSON.parse(localStorage.getItem("rc_custom_cats") || "[]"); } catch { return []; }
  });
  const [activeCustomCatIds,  setActiveCustomCatIds]  = useState(new Set());
  const [newCustomCatName,    setNewCustomCatName]    = useState("");
  const [newCustomCatDesc,    setNewCustomCatDesc]    = useState("");
  const [showCustomCatForm,   setShowCustomCatForm]   = useState(false);

  // Schema upload
  const [schemaDoc,           setSchemaDoc]           = useState(null);
  const [schemaGenerating,    setSchemaGenerating]    = useState(false);
  const [schemaResult,        setSchemaResult]        = useState(null);
  const [schemaError,         setSchemaError]         = useState("");
  const schemaFileRef = useRef(null);
  const [showAppKey,  setShowAppKey]  = useState(false);

  // External classifiers
  const [classifiers,       setClassifiers]       = useState(() => { try { return JSON.parse(localStorage.getItem("rc_classifiers") || "[]"); } catch { return []; } });
  const [classifiersSaving, setClassifiersSaving] = useState(false);
  const [showAddClassifier, setShowAddClassifier] = useState(false);
  const [clfForm, setClfForm] = useState({
    name: "", endpoint: "", method: "POST",
    inputField: "text", textTitle: true, textKeywords: true, textAbstract: true,
    arrayPath: "", labelField: "", scoreField: "", threshold: "0.5",
    rateLimit: "5", storageKey: "", tip: "", headersRaw: "",
  });

  const [expositions,   setExpositions]   = useState(null);
  const [isSemantic,    setIsSemantic]    = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError,   setSearchError]   = useState("");

  const [answer,       setAnswer]       = useState("");
  const [answerLoading,setAnswerLoading] = useState(false);
  const [answerError,  setAnswerError]   = useState("");
  const [loadingMsg,   setLoadingMsg]    = useState("");

  // Exposition conversation state
  const [selectedIds,    setSelectedIds]    = useState(new Set());
  const [expoQuery,      setExpoQuery]      = useState("");
  const [expoConversation, setExpoConversation] = useState([]); // [{q, a}]
  const [expoSystemCtx,  setExpoSystemCtx]  = useState("");    // fetched content, system prompt
  const [expoCtxIds,     setExpoCtxIds]     = useState(null);  // Set snapshot for current ctx
  const [expoLoading,    setExpoLoading]    = useState(false);
  const [expoError,      setExpoError]      = useState("");
  const [expoMsg,        setExpoMsg]        = useState("");

  const conversationEndRef = useRef(null);

  useEffect(() => {
    if (expoConversation.length > 0) {
      conversationEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [expoConversation]);

  useEffect(() => {
    if (analyticsConversation.length > 0) {
      analyticsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [analyticsConversation]);

  function downloadAnswer() {
    const date = new Date().toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" });
    const sources = (expositions || []).slice(0, 10)
      .map((e, i) => `${i + 1}. **${e.title}** — ${e.author}  \n   ${e.url}`)
      .join("\n");
    const slug = query.slice(0, 40).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    downloadMarkdown(`rc-answer-${slug}.md`,
      `# Research Catalogue — AI Answer\n\n**Query:** ${query}  \n**Date:** ${date}\n\n---\n\n${answer}\n\n---\n\n## Sources\n\n${sources}\n`
    );
  }

  function downloadAnalytics() {
    const date = new Date().toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" });
    const slug = (analyticsConversation[0]?.q || "analytics").slice(0, 40).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const thread = analyticsConversation.map(({ q, a }) => `**Q:** ${q}\n\n${a}`).join("\n\n---\n\n");
    downloadMarkdown(`rc-analytics-${slug}.md`,
      `# Research Catalogue — Corpus Analysis\n\n**Date:** ${date}\n\n---\n\n${thread}\n`
    );
  }

  function downloadConversation() {
    const date = new Date().toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" });
    const selected = (expositions || []).filter(e => selectedIds.has(e.id));
    const expoList = selected
      .map((e, i) => `${i + 1}. **${e.title}** — ${e.author}  \n   ${e.url}`)
      .join("\n");
    const thread = expoConversation
      .map(({ q, a }) => `**Q:** ${q}\n\n${a}`)
      .join("\n\n---\n\n");
    const slug = query.slice(0, 40).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    downloadMarkdown(`rc-analysis-${slug}.md`,
      `# Research Catalogue — Exposition Analysis\n\n**Date:** ${date}  \n**Search query:** ${query}\n\n---\n\n## Expositions analysed\n\n${expoList}\n\n---\n\n## Analysis\n\n${thread}\n`
    );
  }

  function autoKey(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }

  function parseHeadersRaw(raw) {
    const result = {};
    for (const line of (raw || "").split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) result[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return result;
  }

  async function saveClassifiers(list) {
    const updated = list ?? classifiers;
    localStorage.setItem("rc_classifiers", JSON.stringify(updated));
    if (!semanticUrl) return;
    setClassifiersSaving(true);
    try {
      const res = await fetch(siblingFnUrl(semanticUrl, "schema-builder"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-app-key": appKey },
        body: JSON.stringify({ action: "save-config", key: "classifier_config", value: updated }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || res.statusText); }
    } catch (err) {
      console.warn("Could not sync classifiers to Supabase:", err.message);
    } finally {
      setClassifiersSaving(false);
    }
  }

  function addAuroraSdgTemplate() {
    if (classifiers.some(c => c.id === "aurora-sdg-multi")) return;
    const tpl = {
      id: "aurora-sdg-multi", name: "SDG Labels (Aurora)", enabled: true,
      endpoint: "https://aurora-sdg.labs.vu.nl/classifier/classify/aurora-sdg-multi",
      method: "POST",
      input: { field: "text", text_fields: ["title", "keywords", "abstract"] },
      response: { array_path: "predictions", label_field: "name", score_field: "", threshold: 0.5 },
      storage_key: "sdg_labels", rate_limit: 4.5, headers: {},
      tip: "SDG classification via Aurora mBERT model (104 languages)",
    };
    const updated = [...classifiers, tpl];
    setClassifiers(updated);
    saveClassifiers(updated);
  }

  function toggleClassifierEnabled(id) {
    const updated = classifiers.map(c => c.id === id ? { ...c, enabled: !c.enabled } : c);
    setClassifiers(updated);
    saveClassifiers(updated);
  }

  function deleteClassifier(id) {
    const updated = classifiers.filter(c => c.id !== id);
    setClassifiers(updated);
    saveClassifiers(updated);
  }

  function addNewClassifier() {
    const textFields = [
      ...(clfForm.textTitle    ? ["title"]    : []),
      ...(clfForm.textKeywords ? ["keywords"] : []),
      ...(clfForm.textAbstract ? ["abstract"] : []),
    ];
    const clf = {
      id: Date.now().toString(), name: clfForm.name.trim(), enabled: true,
      endpoint: clfForm.endpoint.trim(), method: clfForm.method,
      input:    { field: clfForm.inputField || "text", text_fields: textFields },
      response: {
        array_path:  clfForm.arrayPath.trim(),
        label_field: clfForm.labelField.trim(),
        score_field: clfForm.scoreField.trim(),
        threshold:   parseFloat(clfForm.threshold) || 0.5,
      },
      storage_key: (clfForm.storageKey.trim() || autoKey(clfForm.name)).replace(/[^a-z0-9_]/g, ""),
      rate_limit: parseFloat(clfForm.rateLimit) || 5,
      headers: parseHeadersRaw(clfForm.headersRaw),
      tip: clfForm.tip.trim(),
    };
    const updated = [...classifiers, clf];
    setClassifiers(updated);
    saveClassifiers(updated);
    setShowAddClassifier(false);
    setClfForm({ name: "", endpoint: "", method: "POST", inputField: "text",
      textTitle: true, textKeywords: true, textAbstract: true,
      arrayPath: "", labelField: "", scoreField: "", threshold: "0.5",
      rateLimit: "5", storageKey: "", tip: "", headersRaw: "" });
  }

  async function runAnalysis(e) {
    e.preventDefault();
    if (!analyticsQ.trim() || !appKey || !semanticUrl) return;
    setAnalyticsLoading(true);
    setAnalyticsError("");
    const currentQ = analyticsQ;
    setAnalyticsQ("");
    try {
      const res = await fetch(siblingFnUrl(semanticUrl, "analytics"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-app-key": appKey },
        body: JSON.stringify({ question: currentQ, model: modelId, history: analyticsConversation }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      setAnalyticsConversation(prev => [...prev, { q: currentQ, a: data.answer }]);
      if (data.total) setCorpusTotal(data.total);
    } catch (err) {
      setAnalyticsError("Analytics error: " + err.message);
      setAnalyticsQ(currentQ);
    } finally {
      setAnalyticsLoading(false);
    }
  }

  // Fetch live filter config from the edge function so new schema dimensions
  // appear without redeploying the app.
  useEffect(() => {
    if (!semanticUrl) return;
    const url = semanticUrl.replace(/^[<\s]+|[>\s]+$/g, "");
    fetch(url)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.filterConfig && Array.isArray(data.filterConfig) && data.filterConfig.length > 0) {
          setFilterOptions(data.filterConfig);
        }
      })
      .catch(() => {});
  }, [semanticUrl]);

  const switchTab = (tab) => {
    setActiveTab(tab);
    if (tab === "semantic") { setUseSemanticSearch(true);  localStorage.setItem("rc_use_semantic", "1"); }
    else if (tab === "keyword") { setUseSemanticSearch(false); localStorage.setItem("rc_use_semantic", "0"); }
    setExpositions(null);
    setAnswer("");
    setAnswerError("");
    setSearchError("");
    setLoadingMsg("");
  };

  const save = (key, setter, storageKey) => (val) => {
    const clean = typeof val === "string" ? val.replace(/^[<\s]+|[>\s]+$/g, "") : val;
    setter(clean);
    if (clean) localStorage.setItem(storageKey, clean);
    else       localStorage.removeItem(storageKey);
  };

  const saveModel = (id) => {
    setModelId(id);
    localStorage.setItem("rc_model", id);
  };

  const toggleSelect = useCallback((id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    if (!expositions) return;
    setSelectedIds(new Set(expositions.map(e => e.id)));
  }, [expositions]);

  const deselectAll = useCallback(() => setSelectedIds(new Set()), []);

  const toggleFilter = (key, value) => {
    setFilters(prev => {
      const cur  = prev[key] || [];
      const next = cur.includes(value) ? cur.filter(v => v !== value) : [...cur, value];
      if (next.length === 0) {
        const { [key]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [key]: next };
    });
  };

  const clearFilters = () => setFilters({});

  const saveCategory = () => {
    if (!newCatName.trim() || !hasFilters) return;
    const cat     = { id: Date.now(), name: newCatName.trim(), filters: { ...filters } };
    const updated = [...savedCategories, cat];
    setSavedCategories(updated);
    localStorage.setItem("rc_categories", JSON.stringify(updated));
    setNewCatName("");
  };

  const deleteCategory = (id) => {
    const updated = savedCategories.filter(c => c.id !== id);
    setSavedCategories(updated);
    localStorage.setItem("rc_categories", JSON.stringify(updated));
  };

  const applyCategory = (cat) => setFilters({ ...cat.filters });

  const toggleCustomCat = (id) => {
    setActiveCustomCatIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const addCustomCat = () => {
    if (!newCustomCatName.trim() || !newCustomCatDesc.trim()) return;
    const cat = { id: Date.now(), name: newCustomCatName.trim(), description: newCustomCatDesc.trim() };
    const updated = [...customCats, cat];
    setCustomCats(updated);
    localStorage.setItem("rc_custom_cats", JSON.stringify(updated));
    setNewCustomCatName("");
    setNewCustomCatDesc("");
    setShowCustomCatForm(false);
  };

  const deleteCustomCat = (id) => {
    setActiveCustomCatIds(prev => { const next = new Set(prev); next.delete(id); return next; });
    const updated = customCats.filter(c => c.id !== id);
    setCustomCats(updated);
    localStorage.setItem("rc_custom_cats", JSON.stringify(updated));
  };

  const generateSchema = async () => {
    if (!schemaDoc || !semanticUrl) return;
    setSchemaGenerating(true);
    setSchemaResult(null);
    setSchemaError("");
    const isPdf = schemaDoc.type === "application/pdf";
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const raw     = e.target.result;
        const content = isPdf ? raw.split(",")[1] : raw;
        const res = await fetch(siblingFnUrl(semanticUrl, "schema-builder"), {
          method:  "POST",
          headers: { "Content-Type": "application/json", "x-app-key": appKey },
          body: JSON.stringify({ document: { type: isPdf ? "pdf" : "text", content }, filename: schemaDoc.name }),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || res.statusText); }
        const data = await res.json();
        setSchemaResult(data);
        // Refresh filter options
        const searchRes = await fetch(semanticUrl.replace(/^[<\s]+|[>\s]+$/g, "")).catch(() => null);
        if (searchRes?.ok) {
          const searchData = await searchRes.json().catch(() => ({}));
          if (searchData?.filterConfig?.length) setFilterOptions(searchData.filterConfig);
        }
      } catch (err) {
        setSchemaError(err.message);
      } finally {
        setSchemaGenerating(false);
      }
    };
    isPdf ? reader.readAsDataURL(schemaDoc) : reader.readAsText(schemaDoc);
  };

  const clearConversation = useCallback(() => {
    setExpoConversation([]);
    setExpoSystemCtx("");
    setExpoCtxIds(null);
    setExpoError("");
    setExpoMsg("");
  }, []);

  const runSearch = useCallback(async (q) => {
    if (!q.trim()) return;
    setSearchLoading(true);
    setSearchError("");
    setAnswer("");
    setAnswerError("");
    setLoadingMsg("");
    setExpositions([]);
    setIsSemantic(false);
    setSelectedIds(new Set());
    setExpoConversation([]);
    setExpoSystemCtx("");
    setExpoCtxIds(null);
    setExpoError("");
    setExpoMsg("");

    let results = [];
    let semantic = false;

    try {
      if (semanticUrl && useSemanticSearch) {
        setLoadingMsg("Searching semantic index…");
        const activeCats = customCats
          .filter(c => activeCustomCatIds.has(c.id))
          .map(c => ({ description: c.description }));
        results  = await fetchSemanticResults(semanticUrl, q, resultLimit, filters, activeCats);
        semantic = true;
      } else {
        results = (await fetchKeywordResults(q)).filter(e => e.title?.trim()).slice(0, resultLimit);
      }
      setExpositions(results);
      setIsSemantic(semantic);
    } catch (e) {
      setSearchError(e.message);
      setSearchLoading(false);
      setLoadingMsg("");
      return;
    }
    setSearchLoading(false);
    setLoadingMsg("");

    if (results.length === 0) return;
    if (!appKey || !semanticUrl) {
      setAnswerError("Open ⚙ settings and enter the API URL and access passphrase to get AI-generated answers.");
      return;
    }

    setAnswerLoading(true);
    try {
      let context;

      if (!semantic && deepSearch) {
        const top = results.slice(0, DEEP_LIMIT);
        const contentMap = {};
        for (let i = 0; i < top.length; i++) {
          setLoadingMsg(`Reading full content: exposition ${i + 1} of ${top.length}…`);
          try {
            const data = await fetchExpositionContent(top[i].id);
            contentMap[top[i].id] = extractText(data);
          } catch (e) {
            console.warn(`Could not fetch content for ${top[i].id}:`, e.message);
          }
        }
        context = buildContext(results, contentMap);
      } else {
        context = buildContext(results);
      }

      setLoadingMsg("Generating answer…");
      const ans = await generateRAGAnswer({ semanticUrl, appKey }, q, context, semantic, modelId,
        (attempt, total, waitMs) =>
          setLoadingMsg(`API busy — retrying (${attempt}/${total}) in ${waitMs / 1000}s…`));
      setAnswer(ans);
    } catch (e) {
      setAnswerError(e.message);
    } finally {
      setAnswerLoading(false);
      setLoadingMsg("");
    }
  }, [appKey, semanticUrl, useSemanticSearch, deepSearch, resultLimit, modelId, filters, customCats, activeCustomCatIds]);

  const queryExpositions = useCallback(async (e) => {
    e.preventDefault();
    if (!expoQuery.trim() || selectedIds.size === 0) return;
    if (!appKey || !semanticUrl) {
      setExpoError("Open ⚙ settings and enter the API URL and access passphrase.");
      return;
    }

    setExpoLoading(true);
    setExpoError("");
    const currentQuestion = expoQuery;

    let systemCtx = expoSystemCtx;
    let currentHistory = expoConversation;

    // Fetch content if this is the first question or the selection has changed
    if (!systemCtx || !setsEqual(selectedIds, expoCtxIds)) {
      currentHistory = [];
      setExpoConversation([]);

      const selected = (expositions || []).filter(exp => selectedIds.has(exp.id));
      const contentMap = {};
      for (let i = 0; i < selected.length; i++) {
        setExpoMsg(`Reading exposition ${i + 1} of ${selected.length}…`);
        try {
          const data = await fetchExpositionContent(selected[i].id);
          contentMap[selected[i].id] = extractText(data);
        } catch (err) {
          console.warn(`Could not fetch content for ${selected[i].id}:`, err.message);
        }
      }

      systemCtx = selected.map((exp, i) => {
        const text = contentMap[exp.id] || exp.matchedText || "";
        return [
          `[${i + 1}] "${exp.title || "Untitled"}" — ${getAuthorName(exp)}`,
          exp.created ? `Published: ${exp.created}` : "",
          (exp.abstract || exp.description || "").slice(0, 500),
          text
            ? `Full content:\n${text.slice(0, EXPO_TEXT_MAX)}${text.length > EXPO_TEXT_MAX ? "…" : ""}`
            : "",
          `URL: ${getExpositionUrl(exp)}`,
        ].filter(Boolean).join("\n");
      }).join("\n\n---\n\n");

      setExpoSystemCtx(systemCtx);
      setExpoCtxIds(new Set(selectedIds));
    }

    setExpoQuery("");
    setExpoMsg("Querying Claude…");
    try {
      const ans = await callClaudeConversation(
        { semanticUrl, appKey }, systemCtx, currentHistory, currentQuestion, modelId,
        (attempt, total, waitMs) =>
          setExpoMsg(`API busy — retrying (${attempt}/${total}) in ${waitMs / 1000}s…`),
      );
      setExpoConversation(prev => [...prev, { q: currentQuestion, a: ans }]);
    } catch (err) {
      setExpoError(err.message);
      setExpoQuery(currentQuestion); // restore on error
    } finally {
      setExpoLoading(false);
      setExpoMsg("");
    }
  }, [appKey, semanticUrl, expoQuery, expoConversation, expoSystemCtx, expoCtxIds, expositions, selectedIds, modelId]);

  const handleSubmit = (e) => { e.preventDefault(); runSearch(query); };

  const usingSemanticIndex  = !!semanticUrl && useSemanticSearch;
  const activeFilterCount   = Object.values(filters).flat().length;
  const hasFilters          = activeFilterCount > 0;
  const numSelected = selectedIds.size;
  const selectionChanged = expoConversation.length > 0 && !setsEqual(selectedIds, expoCtxIds);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-logo">RC</div>
        <div className="header-text">
          <h1 className="app-title">Research Catalogue · RAG Interface</h1>
        </div>
        <div className="header-actions">
          {semanticUrl && corpusTotal && (
            <span className="index-stats">{corpusTotal.toLocaleString()} expositions indexed</span>
          )}
          <button
            className={`settings-toggle${showSettings ? " active" : ""}`}
            onClick={() => setShowSettings(s => !s)}
            title="Settings"
          >⚙</button>
        </div>
      </header>

      {showSettings && (
        <div className="settings-overlay" onClick={e => { if (e.target === e.currentTarget) setShowSettings(false); }}>
          <div className="settings-modal">
            <div className="settings-modal-header">
              <span className="settings-modal-title">Settings</span>
              <button className="settings-modal-close" onClick={() => setShowSettings(false)}>✕</button>
            </div>
            <div className="settings-modal-body">
              <label className="settings-label">
                Access Passphrase <span className="settings-hint">(shared key — enables AI-generated answers)</span>
              </label>
              <div className="settings-input-wrap">
                <input className="settings-input settings-input-key" type={showAppKey ? "text" : "password"} value={appKey}
                  onChange={e => save("key", setAppKey, "rc_app_key")(e.target.value)}
                  placeholder="passphrase" spellCheck={false} autoComplete="off" />
                <button className="settings-reveal" onClick={() => setShowAppKey(s => !s)}
                  title={showAppKey ? "Hide passphrase" : "Show passphrase"}>
                  {showAppKey ? "Hide" : "Show"}
                </button>
              </div>

              <label className="settings-label" style={{ marginTop: 16 }}>
                Semantic Search API URL <span className="settings-hint">(optional — Supabase edge function)</span>
              </label>
              <input className="settings-input" type="url" value={semanticUrl}
                onChange={e => save("url", setSemanticUrl, "rc_semantic_url")(e.target.value)}
                placeholder="https://your-project.supabase.co/functions/v1/swift-processor" spellCheck={false} />
              <p className="settings-note">
                Paste your Supabase edge function URL here. Enables the Semantic and Corpus Analytics tabs.
              </p>

              {semanticUrl && (
                <>
                  <label className="settings-label" style={{ marginTop: 20 }}>
                    Extraction Schema <span className="settings-hint">(upload a document to add new research dimensions)</span>
                  </label>
                  <p className="settings-note">
                    Upload a PDF or text document describing a research taxonomy or framework.
                    Claude will analyze it and propose new metadata dimensions to extract from expositions.
                    After generating, run <code>python3 pipeline.py --extract-only --force</code> on the server to apply.
                  </p>
                  <input type="file" accept=".pdf,.txt,.md" ref={schemaFileRef} style={{ display: "none" }}
                    onChange={e => { setSchemaDoc(e.target.files[0] || null); setSchemaResult(null); setSchemaError(""); }} />
                  <div className="schema-upload-row">
                    <button className="schema-file-btn" onClick={() => schemaFileRef.current?.click()}>
                      {schemaDoc ? schemaDoc.name : "Choose document…"}
                    </button>
                    <button className="filter-save-btn" onClick={generateSchema} disabled={!schemaDoc || schemaGenerating}>
                      {schemaGenerating ? "Analyzing…" : "Generate schema"}
                    </button>
                  </div>
                  {schemaError && <p className="answer-error" style={{ marginTop: 8 }}>{schemaError}</p>}
                  {schemaResult && (
                    <div className="schema-result">
                      <p className="schema-result-summary">{schemaResult.summary}</p>
                      {schemaResult.new_dimensions?.length > 0 ? (
                        <>
                          <p className="schema-result-label">New dimensions added ({schemaResult.new_dimensions.length}):</p>
                          <ul className="schema-result-list">
                            {schemaResult.new_dimensions.map(d => (
                              <li key={d.key}>
                                <strong>{d.label}</strong> — {d.app_tip || d.prompt}
                                {d.values?.length > 0 && <span className="schema-result-values"> [{d.values.join(", ")}]</span>}
                              </li>
                            ))}
                          </ul>
                          <p className="settings-note">Schema saved to Supabase. Re-run the pipeline to extract these dimensions from all expositions.</p>
                        </>
                      ) : (
                        <p className="settings-note">No new dimensions were identified in this document.</p>
                      )}
                    </div>
                  )}

                  <div className="settings-section-divider" />
                  <label className="settings-label" style={{ marginTop: 12 }}>
                    External Classifiers <span className="settings-hint">(call any HTTP API to add structured labels)</span>
                  </label>
                  <p className="settings-note">
                    Classifiers tag every exposition by calling an external API — no AI required. After configuring, run <code>python3 pipeline.py --classify-only</code> on the server. Labels appear automatically as search filter chips.
                  </p>
                  {classifiers.length > 0 && (
                    <div className="classifier-list">
                      {classifiers.map(clf => (
                        <div key={clf.id} className="classifier-item">
                          <div className="classifier-item-header">
                            <label className="classifier-toggle-label">
                              <input type="checkbox" checked={clf.enabled !== false}
                                onChange={() => toggleClassifierEnabled(clf.id)} />
                              <strong className="classifier-item-name">{clf.name}</strong>
                              <code className="classifier-item-key">{clf.storage_key}</code>
                            </label>
                            <button className="classifier-delete-btn" title="Remove"
                              onClick={() => deleteClassifier(clf.id)}>×</button>
                          </div>
                          <div className="classifier-item-url">{clf.endpoint}</div>
                        </div>
                      ))}
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
                        <button className="filter-save-btn" onClick={() => saveClassifiers()} disabled={classifiersSaving}>
                          {classifiersSaving ? "Saving…" : "Sync to Supabase"}
                        </button>
                        <span className="settings-note" style={{ margin: 0 }}>pipeline reads from Supabase</span>
                      </div>
                    </div>
                  )}
                  {!showAddClassifier ? (
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button className="custom-cat-add-btn" onClick={() => setShowAddClassifier(true)}>+ Add classifier</button>
                      <button className="custom-cat-add-btn" onClick={addAuroraSdgTemplate}
                        disabled={classifiers.some(c => c.id === "aurora-sdg-multi")}
                        title="Adds the Aurora Universities SDG classifier — tags expositions against the 17 UN Sustainable Development Goals">
                        {classifiers.some(c => c.id === "aurora-sdg-multi") ? "Aurora SDG added" : "+ Aurora SDG (template)"}
                      </button>
                    </div>
                  ) : (
                    <div className="classifier-form">
                      <div className="clf-row">
                        <div className="clf-field clf-field-grow">
                          <span className="clf-label">Name *</span>
                          <input className="filter-save-input" value={clfForm.name}
                            onChange={e => { const n = e.target.value; setClfForm(f => ({ ...f, name: n, storageKey: f.storageKey || autoKey(n) })); }}
                            placeholder="SDG Labels (Aurora)" />
                        </div>
                        <div className="clf-field">
                          <span className="clf-label">Storage key *</span>
                          <input className="filter-save-input clf-mono" value={clfForm.storageKey}
                            onChange={e => setClfForm(f => ({ ...f, storageKey: e.target.value }))}
                            placeholder="sdg_labels" />
                        </div>
                      </div>
                      <div className="clf-row">
                        <div className="clf-field clf-field-grow">
                          <span className="clf-label">Endpoint URL *</span>
                          <input className="filter-save-input clf-mono" type="url" value={clfForm.endpoint}
                            onChange={e => setClfForm(f => ({ ...f, endpoint: e.target.value }))}
                            placeholder="https://example.com/classify" />
                        </div>
                        <div className="clf-field clf-field-narrow">
                          <span className="clf-label">Method</span>
                          <select className="clf-select" value={clfForm.method}
                            onChange={e => setClfForm(f => ({ ...f, method: e.target.value }))}>
                            <option>POST</option><option>GET</option>
                          </select>
                        </div>
                      </div>
                      <div className="clf-row">
                        <div className="clf-field clf-field-narrow">
                          <span className="clf-label">Input field</span>
                          <input className="filter-save-input clf-mono" value={clfForm.inputField}
                            onChange={e => setClfForm(f => ({ ...f, inputField: e.target.value }))}
                            placeholder="text" />
                        </div>
                        <div className="clf-field clf-field-grow">
                          <span className="clf-label">Text to classify</span>
                          <div className="clf-checkboxes">
                            {[["textTitle","Title"],["textKeywords","Keywords"],["textAbstract","Abstract"]].map(([key, lbl]) => (
                              <label key={key} className="clf-check-label">
                                <input type="checkbox" checked={!!clfForm[key]}
                                  onChange={e => setClfForm(f => ({ ...f, [key]: e.target.checked }))} />
                                {lbl}
                              </label>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="clf-row">
                        <div className="clf-field clf-field-grow">
                          <span className="clf-label">Response array path <span className="clf-hint">(blank = root)</span></span>
                          <input className="filter-save-input clf-mono" value={clfForm.arrayPath}
                            onChange={e => setClfForm(f => ({ ...f, arrayPath: e.target.value }))}
                            placeholder="predictions" />
                        </div>
                        <div className="clf-field">
                          <span className="clf-label">Label field <span className="clf-hint">(blank if strings)</span></span>
                          <input className="filter-save-input clf-mono" value={clfForm.labelField}
                            onChange={e => setClfForm(f => ({ ...f, labelField: e.target.value }))}
                            placeholder="sdg" />
                        </div>
                      </div>
                      <div className="clf-row">
                        <div className="clf-field">
                          <span className="clf-label">Score field <span className="clf-hint">(optional)</span></span>
                          <input className="filter-save-input clf-mono" value={clfForm.scoreField}
                            onChange={e => setClfForm(f => ({ ...f, scoreField: e.target.value }))}
                            placeholder="prediction" />
                        </div>
                        {clfForm.scoreField && (
                          <div className="clf-field clf-field-narrow">
                            <span className="clf-label">Threshold (0–1)</span>
                            <input className="filter-save-input clf-mono" type="number"
                              min="0" max="1" step="0.05" value={clfForm.threshold}
                              onChange={e => setClfForm(f => ({ ...f, threshold: e.target.value }))} />
                          </div>
                        )}
                        <div className="clf-field clf-field-narrow">
                          <span className="clf-label">Rate limit (req/s)</span>
                          <input className="filter-save-input clf-mono" type="number"
                            min="0.1" step="0.5" value={clfForm.rateLimit}
                            onChange={e => setClfForm(f => ({ ...f, rateLimit: e.target.value }))} />
                        </div>
                      </div>
                      <div className="clf-row">
                        <div className="clf-field clf-field-grow">
                          <span className="clf-label">Filter tip <span className="clf-hint">(shown to users)</span></span>
                          <input className="filter-save-input" value={clfForm.tip}
                            onChange={e => setClfForm(f => ({ ...f, tip: e.target.value }))}
                            placeholder="SDG classification via Aurora mBERT (104 languages)" />
                        </div>
                      </div>
                      <div className="clf-row">
                        <div className="clf-field clf-field-grow">
                          <span className="clf-label">Custom headers <span className="clf-hint">(one per line: Key: Value)</span></span>
                          <textarea className="custom-cat-desc" rows={2} value={clfForm.headersRaw}
                            onChange={e => setClfForm(f => ({ ...f, headersRaw: e.target.value }))}
                            placeholder={"Authorization: Bearer token\nX-API-Key: key"} />
                        </div>
                      </div>
                      <div className="custom-cat-footer">
                        <span className="custom-cat-note">Storage key is the filter dimension ID — must be unique and lowercase.</span>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button className="filter-clear-inline" onClick={() => {
                            setShowAddClassifier(false);
                            setClfForm({ name: "", endpoint: "", method: "POST", inputField: "text",
                              textTitle: true, textKeywords: true, textAbstract: true,
                              arrayPath: "", labelField: "", scoreField: "", threshold: "0.5",
                              rateLimit: "5", storageKey: "", tip: "", headersRaw: "" });
                          }}>Cancel</button>
                          <button className="filter-save-btn" onClick={addNewClassifier}
                            disabled={!clfForm.name.trim() || !clfForm.endpoint.trim()}>
                            Add classifier
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <main className="app-main">
        {/* ── Tab bar ──────────────────────────────────────────────── */}
        <div className="tab-bar">
          <button className={`tab-btn${activeTab === "keyword" ? " tab-btn-active" : ""}`}
            onClick={() => switchTab("keyword")}>Keyword</button>
          <button
            className={`tab-btn${activeTab === "semantic" ? " tab-btn-active" : ""}${!semanticUrl ? " tab-btn-disabled" : ""}`}
            onClick={() => semanticUrl && switchTab("semantic")}
            title={!semanticUrl ? "Configure Supabase URL in Settings to enable" : ""}>
            Semantic
          </button>
          <button
            className={`tab-btn${activeTab === "analytics" ? " tab-btn-active" : ""}${!semanticUrl ? " tab-btn-disabled" : ""}`}
            onClick={() => semanticUrl && switchTab("analytics")}
            title={!semanticUrl ? "Configure Supabase URL in Settings to enable" : ""}>
            Corpus Analytics
          </button>
        </div>

        {/* ── Keyword tab ───────────────────────────────────────────── */}
        {activeTab === "keyword" && (
          <div className="tab-panel">
            <div className="info-box">
              <button className="info-toggle" onClick={() => setShowInfoKeyword(s => !s)}>
                {showInfoKeyword ? "▲ Hide" : "? How it works"}
              </button>
              {showInfoKeyword && (
                <div className="info-content">
                  <p><strong>What it does:</strong> Searches the Research Catalogue's own keyword index — titles, abstracts, and keyword fields only.</p>
                  <p><strong>Best for:</strong> Known terms, author names, specific work titles, or exact concepts you expect to appear verbatim in the text.</p>
                  <p><strong>AI answer:</strong> Claude reads the top results and generates a synthesised answer. Enable Deep search to read full exposition content — much richer responses, but significantly slower.</p>
                  <p><strong>Limitations:</strong> Matches only exact terms — misses synonyms, related concepts, or content buried in exposition body text. No category filtering available in this mode.</p>
                </div>
              )}
            </div>
            <form onSubmit={handleSubmit} className="search-form">
              <input className="search-input" type="text" value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search by keyword, author, or title…"
                disabled={searchLoading || answerLoading} autoFocus />
              <button className="search-btn" type="submit"
                disabled={searchLoading || answerLoading || !query.trim()}>
                {searchLoading ? "…" : "Search"}
              </button>
            </form>
            <label className="deep-toggle"
              title="Fetches and reads the full text of the top results before generating the AI answer. Slower but gives much richer responses.">
              <input type="checkbox" checked={deepSearch}
                onChange={e => { setDeepSearch(e.target.checked); localStorage.setItem("rc_deep_search", e.target.checked ? "1" : ""); }} />
              <span className="deep-label">Deep search</span>
              <span className="deep-hint"> — reads full exposition content, not just abstracts (slower)</span>
            </label>
          </div>
        )}

        {/* ── Semantic tab ──────────────────────────────────────────── */}
        {activeTab === "semantic" && (
          <div className="tab-panel">
            <div className="info-box">
              <button className="info-toggle" onClick={() => setShowInfoSemantic(s => !s)}>
                {showInfoSemantic ? "▲ Hide" : "? How it works"}
              </button>
              {showInfoSemantic && (
                <div className="info-content">
                  <p><strong>What it does:</strong> Searches the full text of all expositions by meaning using vector embeddings. Finds conceptually related content even when different words are used.</p>
                  <p><strong>Best for:</strong> Broad conceptual questions, exploring a research area without knowing its specific terminology, finding thematically related work.</p>
                  <p><strong>Filters:</strong> Narrow results by research approach, artistic medium, impact type, methodological framing, or journal. Results must match all selected categories; within a category any selected value matches. Save combinations as named presets.</p>
                  <p><strong>Custom categories:</strong> Define your own semantic categories in plain language — the search engine finds expositions that match your description conceptually, not just by keyword.</p>
                  <p><strong>Limitations:</strong> Requires the Supabase index to be configured. ~96% of expositions have extracted metadata; the remainder may be under-represented in filtered results.</p>
                </div>
              )}
            </div>
            <form onSubmit={handleSubmit} className="search-form">
              <input className="search-input" type="text" value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search by concept, theme, or research question…"
                disabled={searchLoading || answerLoading} autoFocus />
              <button className="search-btn" type="submit"
                disabled={searchLoading || answerLoading || !query.trim()}>
                {searchLoading ? "…" : "Search"}
              </button>
            </form>

            <div className="filter-section">
              <div className="filter-section-header">
                <div className="filter-section-left">
                  <span className="filter-section-title">
                    Filters{hasFilters && <span className="filter-active-count"> · {activeFilterCount} active</span>}
                  </span>
                  {hasFilters && <button className="filter-clear-inline" onClick={clearFilters}>Clear all</button>}
                </div>
                {savedCategories.length > 0 && (
                  <div className="filter-section-cats">
                    <span className="filter-cats-label">Saved:</span>
                    {savedCategories.map(cat => (
                      <button key={cat.id} className="saved-cat-chip" onClick={() => applyCategory(cat)}
                        title={Object.entries(cat.filters).map(([k, v]) => `${k}: ${v.join(", ")}`).join("\n")}>
                        {cat.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="filter-panel">
                <p className="filter-panel-note">
                  Within a category results match <em>any</em> selected value; across categories all must match.
                </p>
                {filterOptions.filter(f => f.values.length > 0).map(({ label, key, tip, values }) => (
                  <div key={key} className="filter-group">
                    <span className="filter-group-label" title={tip}>{label} <span className="filter-tip-icon" title={tip}>?</span></span>
                    <div className="filter-chips">
                      {values.map(val => {
                        const active = (filters[key] || []).includes(val);
                        return (
                          <button key={val} className={`filter-chip${active ? " filter-chip-active" : ""}`}
                            onClick={() => toggleFilter(key, val)}>{val}</button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                <div className="filter-save-row">
                  <input className="filter-save-input" value={newCatName}
                    onChange={e => setNewCatName(e.target.value)}
                    placeholder="Name this filter combination to save as a preset…"
                    onKeyDown={e => e.key === "Enter" && saveCategory()} />
                  <button className="filter-save-btn" onClick={saveCategory}
                    disabled={!newCatName.trim() || !hasFilters}
                    title="Save the current filter selection as a named category for quick reuse.">
                    Save preset
                  </button>
                </div>
                {savedCategories.length > 0 && (
                  <div className="filter-group">
                    <span className="filter-group-label">Saved presets</span>
                    <div className="filter-chips">
                      {savedCategories.map(cat => (
                        <span key={cat.id} className="saved-cat-row">
                          <button className="filter-chip" onClick={() => applyCategory(cat)}
                            title={Object.entries(cat.filters).map(([k, v]) => `${k}: ${v.join(", ")}`).join("\n")}>
                            {cat.name}
                          </button>
                          <button className="saved-cat-delete" onClick={() => deleteCategory(cat.id)} title="Delete">×</button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                <div className="filter-group custom-cat-section">
                  <span className="filter-group-label"
                    title="Define categories in plain language. The search engine embeds your description and finds semantically similar expositions — even if they use different words.">
                    Custom semantic categories <span className="filter-tip-icon">?</span>
                  </span>
                  {customCats.length > 0 && (
                    <div className="filter-chips">
                      {customCats.map(cat => {
                        const active = activeCustomCatIds.has(cat.id);
                        return (
                          <span key={cat.id} className="saved-cat-row">
                            <button className={`filter-chip${active ? " filter-chip-active" : ""}`}
                              onClick={() => toggleCustomCat(cat.id)} title={cat.description}>
                              {cat.name}
                            </button>
                            <button className="saved-cat-delete" onClick={() => deleteCustomCat(cat.id)} title="Delete">×</button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {!showCustomCatForm ? (
                    <button className="custom-cat-add-btn" onClick={() => setShowCustomCatForm(true)}>+ Add custom category</button>
                  ) : (
                    <div className="custom-cat-form">
                      <input className="filter-save-input" value={newCustomCatName}
                        onChange={e => setNewCustomCatName(e.target.value)}
                        placeholder="Category name (e.g. Nordic sound art)" />
                      <textarea className="custom-cat-desc" value={newCustomCatDesc}
                        onChange={e => setNewCustomCatDesc(e.target.value)}
                        placeholder="Describe what expositions in this category have in common. Be specific — e.g. 'sound installation and acoustic performance in Scandinavian or Nordic contexts, including works by artists from Norway, Sweden, Denmark, Finland or Iceland.'"
                        rows={3} />
                      <div className="custom-cat-footer">
                        <span className="custom-cat-note">Each active category adds ~0.5s to search.</span>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button className="filter-clear-inline" onClick={() => { setShowCustomCatForm(false); setNewCustomCatName(""); setNewCustomCatDesc(""); }}>Cancel</button>
                          <button className="filter-save-btn" onClick={addCustomCat}
                            disabled={!newCustomCatName.trim() || !newCustomCatDesc.trim()}>Save</button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Corpus Analytics tab ──────────────────────────────────── */}
        {activeTab === "analytics" && (
          <div className="tab-panel">
            <div className="info-box">
              <button className="info-toggle" onClick={() => setShowInfoAnalytics(s => !s)}>
                {showInfoAnalytics ? "▲ Hide" : "? How it works"}
              </button>
              {showInfoAnalytics && (
                <div className="info-content">
                  <p><strong>What it does:</strong> Asks Claude analytical questions about the full corpus{corpusTotal ? ` (${corpusTotal.toLocaleString()} expositions)` : " (6,500+ expositions)"}. Claude reads aggregated statistics — distributions, trends, cross-tabulations across journals, years, and metadata dimensions — not individual works.</p>
                  <p><strong>Best for:</strong> Identifying trends over time, comparing journals, understanding the distribution of research approaches or artistic media across the whole RC.</p>
                  <p><strong>Follow-up questions:</strong> Ask a question, then refine or dig deeper — the conversation builds on previous answers without re-fetching statistics each time.</p>
                  <p><strong>Limitations:</strong> Works with metadata distributions only, not exposition content. Cannot find specific expositions, quote passages, or answer questions that require reading individual works. Statistics cover ~96% of expositions with extracted metadata.</p>
                </div>
              )}
            </div>

            {analyticsConversation.length > 0 && (
              <div className="analytics-answer">
                <div className="analytics-answer-header">
                  <span className="analytics-answer-label">Corpus Analysis</span>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button className="download-btn" onClick={downloadAnalytics} title="Download analysis as Markdown">↓ Download</button>
                    <button className="download-btn" onClick={() => setAnalyticsConversation([])} title="Clear conversation">Clear</button>
                  </div>
                </div>
                <div className="expo-conversation">
                  {analyticsConversation.map(({ q, a }, i) => (
                    <div key={i} className="expo-exchange">
                      <div className="expo-exchange-q">
                        <span className="exchange-label">Q</span>
                        <span className="exchange-text">{q}</span>
                      </div>
                      <div className="expo-exchange-a">
                        <span className="exchange-label exchange-label-a">A</span>
                        <div className="exchange-text"><ReactMarkdown>{a}</ReactMarkdown></div>
                      </div>
                    </div>
                  ))}
                  {analyticsLoading && (
                    <div className="expo-exchange">
                      <div className="expo-exchange-q">
                        <span className="exchange-label">Q</span>
                        <span className="exchange-text">{analyticsQ || "…"}</span>
                      </div>
                      <div className="expo-exchange-a">
                        <span className="exchange-label exchange-label-a">A</span>
                        <p className="answer-loading" style={{ margin: 0 }}>Fetching corpus statistics and generating analysis…</p>
                      </div>
                    </div>
                  )}
                  <div ref={analyticsEndRef} />
                </div>
              </div>
            )}
            <form className="analytics-form" onSubmit={runAnalysis}>
              <textarea className="analytics-input" value={analyticsQ}
                onChange={e => setAnalyticsQ(e.target.value)}
                placeholder={analyticsConversation.length > 0
                  ? "Ask a follow-up question…"
                  : "Ask a question about trends, distributions, or patterns across the corpus…"}
                rows={3} disabled={analyticsLoading} />
              <div className="analytics-footer">
                <div className="model-selector">
                  {MODELS.map(m => (
                    <button key={m.id} type="button"
                      className={`model-btn${modelId === m.id ? " model-btn-active" : ""}`}
                      onClick={() => saveModel(m.id)} title={m.note}>{m.label}</button>
                  ))}
                </div>
                <button className="analytics-submit-btn" type="submit"
                  disabled={analyticsLoading || !analyticsQ.trim() || !appKey}>
                  {analyticsLoading ? "Analysing…" : "Analyse"}
                </button>
              </div>
            </form>
            {analyticsError && <p className="answer-error">{analyticsError}</p>}
            {analyticsConversation.length === 0 && analyticsLoading && (
              <p className="answer-loading">Fetching corpus statistics and generating analysis…</p>
            )}
          </div>
        )}

        {/* ── Results (keyword / semantic only) ────────────────────── */}
        {activeTab !== "analytics" && (
          <>
            {searchError && <div className="search-error">{searchError}</div>}

            <AnswerPanel answer={answer} loading={answerLoading}
              loadingMsg={loadingMsg} error={answerError}
              onDownload={answer ? downloadAnswer : null} />

            {expositions !== null && !searchLoading && (
              <section className="results-section">
                <div className="results-header">
                  <h2 className="section-label">
                    {expositions.length === 0
                      ? "No results found"
                      : `${expositions.length} exposition${expositions.length !== 1 ? "s" : ""} retrieved`}
                  </h2>
                  <div className="results-limit-row">
                    <span className="results-limit-label">Show</span>
                    {[10, 25, 50].map(n => (
                      <button key={n} className={`limit-btn${resultLimit === n ? " limit-btn-active" : ""}`}
                        onClick={() => { setResultLimit(n); localStorage.setItem("rc_result_limit", n); }}>{n}</button>
                    ))}
                  </div>
                  {expositions.length > 0 && (
                    <div className="select-controls">
                      <button className="select-btn" onClick={selectAll} disabled={numSelected === expositions.length}>Select all</button>
                      {numSelected > 0 && <button className="select-btn" onClick={deselectAll}>Deselect all</button>}
                      {numSelected > 0 && <span className="select-count">{numSelected} selected</span>}
                    </div>
                  )}
                </div>

                <div className="results-list">
                  {expositions.map((exp, i) => (
                    <ExpositionCard key={exp.id ?? i} exp={exp} index={i} semantic={isSemantic}
                      selected={selectedIds.has(exp.id)} onToggle={toggleSelect} />
                  ))}
                </div>

                {expositions.length > 0 && (
                  <div className="expo-query-panel">
                    <div className="expo-query-header">
                      <h3 className="expo-query-title">
                        Query selected expositions
                        {numSelected > 0 && <span className="expo-query-count">{numSelected} selected</span>}
                      </h3>
                      {expoConversation.length > 0 && (
                        <div className="expo-header-actions">
                          <button className="download-btn" onClick={downloadConversation} title="Download analysis as a Markdown file">↓ Download</button>
                          <button className="expo-clear-btn" onClick={clearConversation} title="Clear conversation and start fresh">Clear</button>
                        </div>
                      )}
                    </div>

                    {selectionChanged && (
                      <p className="expo-selection-note">
                        Selection changed — your next question will start a new conversation with the updated set of expositions.
                      </p>
                    )}

                    {expoConversation.length === 0 && !expoLoading && (
                      <p className="expo-query-hint">
                        {numSelected === 0
                          ? "Select one or more expositions above (checkboxes), then ask a detailed question."
                          : `Claude will read the full content of ${numSelected} exposition${numSelected !== 1 ? "s" : ""} and answer in detail.`}
                      </p>
                    )}

                    {expoConversation.length > 0 && (
                      <div className="expo-conversation">
                        {expoConversation.map(({ q, a }, i) => (
                          <div key={i} className="expo-exchange">
                            <div className="expo-exchange-q">
                              <span className="exchange-label">Q</span>
                              <span className="exchange-text">{q}</span>
                            </div>
                            <div className="expo-exchange-a">
                              <span className="exchange-label exchange-label-a">A</span>
                              <div className="exchange-text"><ReactMarkdown>{a}</ReactMarkdown></div>
                            </div>
                          </div>
                        ))}
                        {expoLoading && (
                          <div className="expo-exchange">
                            <div className="expo-exchange-q">
                              <span className="exchange-label">Q</span>
                              <span className="exchange-text">{expoQuery || "…"}</span>
                            </div>
                            <p className="answer-loading expo-loading-inline">{expoMsg || "Generating…"}</p>
                          </div>
                        )}
                        {expoError && <p className="answer-error" style={{ marginTop: 8 }}>{expoError}</p>}
                        <div ref={conversationEndRef} />
                      </div>
                    )}

                    {expoLoading && expoConversation.length === 0 && (
                      <p className="answer-loading" style={{ marginBottom: 10 }}>{expoMsg || "Generating…"}</p>
                    )}
                    {expoError && expoConversation.length === 0 && (
                      <p className="answer-error" style={{ marginBottom: 10 }}>{expoError}</p>
                    )}

                    <div className="expo-model-row">
                      <div className="model-selector">
                        {MODELS.map(m => (
                          <button key={m.id} className={`model-btn${modelId === m.id ? " model-btn-active" : ""}`}
                            onClick={() => saveModel(m.id)} title={m.note}>{m.label}</button>
                        ))}
                      </div>
                      <span className="expo-model-note">
                        Haiku is fastest but can be temporarily overloaded — switch to Sonnet if you see an error.
                      </span>
                    </div>

                    <form className="expo-query-form" onSubmit={queryExpositions}>
                      <input className="expo-query-input" type="text" value={expoQuery}
                        onChange={e => setExpoQuery(e.target.value)}
                        placeholder={expoConversation.length > 0 ? "Ask a follow-up question…" : "Ask a detailed question about the selected expositions…"}
                        disabled={expoLoading} />
                      <button className="expo-query-btn" type="submit"
                        disabled={expoLoading || numSelected === 0 || !expoQuery.trim()}>
                        {expoLoading ? "…" : expoConversation.length > 0 ? "Send" : "Query"}
                      </button>
                    </form>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </main>

      <footer className="app-footer">
        Data:{" "}
        <a href="https://www.researchcatalogue.net" target="_blank" rel="noopener noreferrer">Research Catalogue</a>
        {" · "}
        <a href="https://rcdata.org" target="_blank" rel="noopener noreferrer">RCData</a>
        {" · "}
        Society for Artistic Research
      </footer>
    </div>
  );
}
