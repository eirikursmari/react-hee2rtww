import React, { useState, useCallback, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import "./style.css";

const RC_SEARCH_URL  = "https://www.researchcatalogue.net/portal/search-result";
const RC_CONTENT_URL = "https://map.rcdata.org/rcjson/expo";
const CORS_PROXY     = "https://corsproxy.io/?";
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";

const MODELS = [
  { id: "claude-haiku-4-5-20251001", label: "Haiku",  note: "fastest · lowest cost" },
  { id: "claude-sonnet-4-6",         label: "Sonnet", note: "balanced"              },
  { id: "claude-opus-4-7",           label: "Opus",   note: "most capable"         },
];
const DEEP_LIMIT     = 5;
const DEEP_TEXT_MAX  = 2500;
const EXPO_TEXT_MAX  = 8000;

// ── Network helpers ───────────────────────────────────────────────────────────

function isCorsError(e) {
  return ["Failed to fetch", "NetworkError", "Load failed", "Network request failed"]
    .some(msg => e.message.includes(msg));
}

async function proxiedFetch(url) {
  try {
    return await fetch(url);
  } catch (e) {
    if (!isCorsError(e)) throw e;
    return fetch(`${CORS_PROXY}${encodeURIComponent(url)}`);
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

async function claudePost(body, apiKey, onRetry) {
  const RETRIES = 3;
  const DELAYS  = [3000, 6000, 12000];
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const res = await fetch(CLAUDE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
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

async function generateRAGAnswer(apiKey, query, context, isSemantic, modelId, onRetry) {
  const data = await claudePost({
    model: modelId,
    max_tokens: 4096,
    system: `You are a knowledgeable research assistant for the Research Catalogue (researchcatalogue.net), an international database for artistic research maintained by the Society for Artistic Research.

When answering, cite retrieved expositions by their bracket number [N]. Be concise and insightful; highlight connections between works when relevant.${isSemantic ? " Results were retrieved by semantic similarity — you may find content beyond the abstract that speaks directly to the query." : ""}`,
    messages: [{
      role: "user",
      content: `Query: "${query}"\n\nRetrieved expositions:\n\n${context}\n\nAnswer the query based on these expositions, citing them by [number].`,
    }],
  }, apiKey, onRetry);
  return data.content?.[0]?.text ?? "";
}

// Conversational query — history is [{q, a}, ...], systemCtx is the full exposition content
async function callClaudeConversation(apiKey, systemCtx, history, question, modelId, onRetry) {
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
  }, apiKey, onRetry);
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

function AnswerPanel({ label = "AI Answer", answer, loading, loadingMsg, error }) {
  if (!loading && !loadingMsg && !error && !answer) return null;
  return (
    <section className="answer-section">
      <h2 className="section-label">{label}</h2>
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
];

const EXAMPLES = [
  "artistic practice as research",
  "sound art and performance",
  "material culture and craft",
  "digital and interactive art",
];

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [query,       setQuery]       = useState("");
  const [apiKey,      setApiKey]      = useState(() => localStorage.getItem("rc_claude_key")    || "");
  const [semanticUrl, setSemanticUrl] = useState(() => localStorage.getItem("rc_semantic_url")  || "");
  const [showSettings,setShowSettings]= useState(false);
  const [deepSearch,       setDeepSearch]       = useState(() => localStorage.getItem("rc_deep_search") === "1");
  const [useSemanticSearch,setUseSemanticSearch] = useState(() => localStorage.getItem("rc_use_semantic") !== "0");
  const [modelId,          setModelId]           = useState(() => localStorage.getItem("rc_model") || "claude-sonnet-4-6");
  const [filters,          setFilters]           = useState({});
  const [showFilters,      setShowFilters]       = useState(false);
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
  const [showApiKey,  setShowApiKey]  = useState(false);

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
        const builderUrl = semanticUrl.replace(/^[<\s]+|[>\s]+$/g, "").replace(/\/[^/]+$/, "/schema-builder");
        const res = await fetch(builderUrl, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
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
        results  = await fetchSemanticResults(semanticUrl, q, 10, filters, activeCats);
        semantic = true;
      } else {
        results = await fetchKeywordResults(q);
      }
      if (results.length > 0) console.log("First result:", results[0]);
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
    if (!apiKey) {
      setAnswerError("No API key set — open ⚙ settings and enter your Anthropic API key to get AI-generated answers.");
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
      const ans = await generateRAGAnswer(apiKey, q, context, semantic, modelId,
        (attempt, total, waitMs) =>
          setLoadingMsg(`API busy — retrying (${attempt}/${total}) in ${waitMs / 1000}s…`));
      setAnswer(ans);
    } catch (e) {
      setAnswerError(e.message);
    } finally {
      setAnswerLoading(false);
      setLoadingMsg("");
    }
  }, [apiKey, semanticUrl, useSemanticSearch, deepSearch, modelId, filters, customCats, activeCustomCatIds]);

  const queryExpositions = useCallback(async (e) => {
    e.preventDefault();
    if (!expoQuery.trim() || selectedIds.size === 0) return;
    if (!apiKey) {
      setExpoError("No API key set — open ⚙ settings and enter your Anthropic API key.");
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
        apiKey, systemCtx, currentHistory, currentQuestion, modelId,
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
  }, [apiKey, expoQuery, expoConversation, expoSystemCtx, expoCtxIds, expositions, selectedIds, modelId]);

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
          <p className="app-subtitle">
            Search and query artistic research expositions with AI-assisted retrieval
          </p>
        </div>
      </header>

      <main className="app-main">
        <form onSubmit={handleSubmit} className="search-form">
          <input
            className="search-input"
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Ask a question or search artistic research…"
            disabled={searchLoading || answerLoading}
            autoFocus
          />
          <button className="search-btn" type="submit"
            disabled={searchLoading || answerLoading || !query.trim()}>
            {searchLoading ? "…" : "Search"}
          </button>
          <button type="button"
            className={`settings-toggle${showSettings ? " active" : ""}`}
            onClick={() => setShowSettings(s => !s)}
            title="Settings">
            ⚙
          </button>
        </form>

        <div className="search-options">
          {semanticUrl ? (
            <div className="mode-row">
              <span className="mode-row-label">Search mode</span>
              <div className="mode-toggle-wrap">
                <button
                  className={`mode-toggle-btn${useSemanticSearch ? " mode-toggle-active" : ""}`}
                  onClick={() => { setUseSemanticSearch(true); localStorage.setItem("rc_use_semantic", "1"); }}
                  title="Searches the full text of all expositions by meaning. Finds conceptually related content even without exact keyword matches. Supports category filters."
                >Semantic</button>
                <button
                  className={`mode-toggle-btn${!useSemanticSearch ? " mode-toggle-active" : ""}`}
                  onClick={() => { setUseSemanticSearch(false); localStorage.setItem("rc_use_semantic", "0"); }}
                  title="Searches the Research Catalogue's own index by keyword — faster but limited to titles, abstracts and keywords. No category filters."
                >Keyword</button>
              </div>
              {!useSemanticSearch && (
                <label className="deep-toggle"
                  title="Fetches and reads the full text of the top results before generating the AI answer. Slower but gives much richer responses.">
                  <input type="checkbox" checked={deepSearch}
                    onChange={e => { setDeepSearch(e.target.checked); localStorage.setItem("rc_deep_search", e.target.checked ? "1" : ""); }} />
                  <span className="deep-label">Deep search</span>
                  <span className="deep-hint"> — reads full content (slower)</span>
                </label>
              )}
            </div>
          ) : (
            <label className="deep-toggle"
              title="Fetches and reads the full text of the top results before generating the AI answer. Slower but gives much richer responses.">
              <input type="checkbox" checked={deepSearch}
                onChange={e => { setDeepSearch(e.target.checked); localStorage.setItem("rc_deep_search", e.target.checked ? "1" : ""); }} />
              <span className="deep-label">Deep search</span>
              <span className="deep-hint"> — reads full exposition content, not just abstracts (slower)</span>
            </label>
          )}
        </div>

        {showSettings && (
          <div className="settings-panel">
            <label className="settings-label">
              Anthropic API Key <span className="settings-hint">(enables AI-generated answers)</span>
            </label>
            <div className="settings-input-wrap">
              <input className="settings-input settings-input-key" type={showApiKey ? "text" : "password"} value={apiKey}
                onChange={e => save("key", setApiKey, "rc_claude_key")(e.target.value)}
                placeholder="sk-ant-api03-…" spellCheck={false} autoComplete="off" />
              <button className="settings-reveal" onClick={() => setShowApiKey(s => !s)}
                title={showApiKey ? "Hide key" : "Show key"}>
                {showApiKey ? "Hide" : "Show"}
              </button>
            </div>

            <label className="settings-label" style={{ marginTop: 16 }}>
              Semantic Search API URL <span className="settings-hint">(optional — Vercel endpoint)</span>
            </label>
            <input className="settings-input" type="url" value={semanticUrl}
              onChange={e => save("url", setSemanticUrl, "rc_semantic_url")(e.target.value)}
              placeholder="https://your-project.vercel.app/api/search" spellCheck={false} />
            <p className="settings-note">
              Leave blank to use RC keyword search. Once the semantic index is built and
              deployed, paste the Supabase edge function URL here to enable full-text semantic search.
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
                <input
                  type="file"
                  accept=".pdf,.txt,.md"
                  ref={schemaFileRef}
                  style={{ display: "none" }}
                  onChange={e => { setSchemaDoc(e.target.files[0] || null); setSchemaResult(null); setSchemaError(""); }}
                />
                <div className="schema-upload-row">
                  <button className="schema-file-btn" onClick={() => schemaFileRef.current?.click()}>
                    {schemaDoc ? schemaDoc.name : "Choose document…"}
                  </button>
                  <button
                    className="filter-save-btn"
                    onClick={generateSchema}
                    disabled={!schemaDoc || schemaGenerating}
                  >
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
              </>
            )}
          </div>
        )}

        {semanticUrl && useSemanticSearch && (
          <div className="filter-section">
            <div className="filter-section-header">
              <div className="filter-section-left">
                <button
                  className={`filter-toggle-btn${showFilters ? " active" : ""}${hasFilters ? " filter-toggle-has" : ""}`}
                  onClick={() => setShowFilters(s => !s)}
                  title="Filter semantic search results by automatically extracted categories such as research approach, medium, and impact type."
                >
                  {showFilters ? "▲" : "▼"} {hasFilters ? `Semantic filters (${activeFilterCount} active)` : "Semantic filters"}
                </button>
                {hasFilters && (
                  <button className="filter-clear-inline" onClick={clearFilters}>Clear all</button>
                )}
              </div>
              {savedCategories.length > 0 && (
                <div className="filter-section-cats">
                  <span className="filter-cats-label">Saved:</span>
                  {savedCategories.map(cat => (
                    <button
                      key={cat.id}
                      className="saved-cat-chip"
                      onClick={() => applyCategory(cat)}
                      title={Object.entries(cat.filters).map(([k, v]) => `${k}: ${v.join(", ")}`).join("\n")}
                    >
                      {cat.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {showFilters && (
              <div className="filter-panel">
                <p className="filter-panel-note">
                  Filters apply to semantic search only. Select one or more values — within a category results match <em>any</em> selected value; across categories all must match. Categories are extracted automatically from exposition content by AI.
                </p>
                {filterOptions.map(({ label, key, tip, values }) => (
                  <div key={key} className="filter-group">
                    <span className="filter-group-label" title={tip}>{label} <span className="filter-tip-icon" title={tip}>?</span></span>
                    <div className="filter-chips">
                      {values.map(val => {
                        const active = (filters[key] || []).includes(val);
                        return (
                          <button
                            key={val}
                            className={`filter-chip${active ? " filter-chip-active" : ""}`}
                            onClick={() => toggleFilter(key, val)}
                          >
                            {val}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}

                <div className="filter-save-row">
                  <input
                    className="filter-save-input"
                    value={newCatName}
                    onChange={e => setNewCatName(e.target.value)}
                    placeholder="Name this filter combination to save as a custom category…"
                    onKeyDown={e => e.key === "Enter" && saveCategory()}
                  />
                  <button
                    className="filter-save-btn"
                    onClick={saveCategory}
                    disabled={!newCatName.trim() || !hasFilters}
                    title="Save the current filter selection as a named category for quick reuse."
                  >
                    Save as category
                  </button>
                </div>

                {savedCategories.length > 0 && (
                  <div className="filter-group">
                    <span className="filter-group-label">Saved filter presets</span>
                    <div className="filter-chips">
                      {savedCategories.map(cat => (
                        <span key={cat.id} className="saved-cat-row">
                          <button
                            className="filter-chip"
                            onClick={() => applyCategory(cat)}
                            title={Object.entries(cat.filters).map(([k, v]) => `${k}: ${v.join(", ")}`).join("\n")}
                          >
                            {cat.name}
                          </button>
                          <button className="saved-cat-delete" onClick={() => deleteCategory(cat.id)} title="Delete">×</button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Custom semantic categories */}
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
                            <button
                              className={`filter-chip${active ? " filter-chip-active" : ""}`}
                              onClick={() => toggleCustomCat(cat.id)}
                              title={cat.description}
                            >
                              {cat.name}
                            </button>
                            <button className="saved-cat-delete" onClick={() => deleteCustomCat(cat.id)} title="Delete">×</button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {!showCustomCatForm ? (
                    <button className="custom-cat-add-btn" onClick={() => setShowCustomCatForm(true)}>
                      + Add custom category
                    </button>
                  ) : (
                    <div className="custom-cat-form">
                      <input
                        className="filter-save-input"
                        value={newCustomCatName}
                        onChange={e => setNewCustomCatName(e.target.value)}
                        placeholder="Category name (e.g. Nordic sound art)"
                      />
                      <textarea
                        className="custom-cat-desc"
                        value={newCustomCatDesc}
                        onChange={e => setNewCustomCatDesc(e.target.value)}
                        placeholder="Describe what expositions in this category have in common. Be specific — e.g. 'sound installation and acoustic performance in Scandinavian or Nordic contexts, including works by artists from Norway, Sweden, Denmark, Finland or Iceland.'"
                        rows={3}
                      />
                      <div className="custom-cat-footer">
                        <span className="custom-cat-note">Each active category adds ~0.5s to search.</span>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button className="filter-clear-inline" onClick={() => { setShowCustomCatForm(false); setNewCustomCatName(""); setNewCustomCatDesc(""); }}>Cancel</button>
                          <button className="filter-save-btn" onClick={addCustomCat} disabled={!newCustomCatName.trim() || !newCustomCatDesc.trim()}>Save</button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {searchError && <div className="search-error">{searchError}</div>}

        <AnswerPanel answer={answer} loading={answerLoading}
          loadingMsg={loadingMsg} error={answerError} />

        {expositions !== null && !searchLoading && (
          <section className="results-section">
            <div className="results-header">
              <h2 className="section-label">
                {expositions.length === 0
                  ? "No results found"
                  : `${expositions.length} exposition${expositions.length !== 1 ? "s" : ""} retrieved`}
              </h2>
              {expositions.length > 0 && (
                <div className="select-controls">
                  <button className="select-btn" onClick={selectAll}
                    disabled={numSelected === expositions.length}>
                    Select all
                  </button>
                  {numSelected > 0 && (
                    <button className="select-btn" onClick={deselectAll}>
                      Deselect all
                    </button>
                  )}
                  {numSelected > 0 && (
                    <span className="select-count">{numSelected} selected</span>
                  )}
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
                    Query expositions in detail
                    {numSelected > 0 && (
                      <span className="expo-query-count">{numSelected} selected</span>
                    )}
                  </h3>
                  {expoConversation.length > 0 && (
                    <button className="expo-clear-btn" onClick={clearConversation}
                      title="Clear conversation and start fresh">
                      Clear conversation
                    </button>
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

                {/* Conversation thread */}
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

                {/* Loading state before first answer */}
                {expoLoading && expoConversation.length === 0 && (
                  <p className="answer-loading" style={{ marginBottom: 10 }}>{expoMsg || "Generating…"}</p>
                )}
                {expoError && expoConversation.length === 0 && (
                  <p className="answer-error" style={{ marginBottom: 10 }}>{expoError}</p>
                )}

                <div className="expo-model-row">
                  <div className="model-selector">
                    {MODELS.map(m => (
                      <button
                        key={m.id}
                        className={`model-btn${modelId === m.id ? " model-btn-active" : ""}`}
                        onClick={() => saveModel(m.id)}
                        title={m.note}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                  <span className="expo-model-note">
                    Haiku is fastest but can be temporarily overloaded — switch to Sonnet if you see an error.
                  </span>
                </div>

                <form className="expo-query-form" onSubmit={queryExpositions}>
                  <input
                    className="expo-query-input"
                    type="text"
                    value={expoQuery}
                    onChange={e => setExpoQuery(e.target.value)}
                    placeholder={expoConversation.length > 0
                      ? "Ask a follow-up question…"
                      : "Ask a detailed question about the selected expositions…"}
                    disabled={expoLoading}
                  />
                  <button className="expo-query-btn" type="submit"
                    disabled={expoLoading || numSelected === 0 || !expoQuery.trim()}>
                    {expoLoading ? "…" : expoConversation.length > 0 ? "Send" : "Query"}
                  </button>
                </form>
              </div>
            )}
          </section>
        )}

        {expositions === null && !searchLoading && (
          <div className="landing">
            <p className="landing-lead">
              Query thousands of artistic research expositions from the{" "}
              <a href="https://www.researchcatalogue.net" target="_blank" rel="noopener noreferrer">
                Research Catalogue
              </a>.
            </p>
            <p className="landing-sub">Try one of these:</p>
            <div className="example-list">
              {EXAMPLES.map(q => (
                <button key={q} className="example-btn"
                  onClick={() => { setQuery(q); runSearch(q); }}>{q}</button>
              ))}
            </div>
          </div>
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
