import React, { useState, useCallback } from "react";
import "./style.css";

const RC_SEARCH_URL = "https://www.researchcatalogue.net/portal/search-result";
const CORS_PROXY = "https://corsproxy.io/?";
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = "claude-sonnet-4-6";

function normalizeResults(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.expositions)) return data.expositions;
  if (data && Array.isArray(data.results)) return data.results;
  return [];
}

function isCorsError(e) {
  return ["Failed to fetch", "NetworkError", "Load failed", "Network request failed"]
    .some(msg => e.message.includes(msg));
}

async function fetchExpositions(query, page = 0) {
  const params = new URLSearchParams({
    fulltext: query,
    statuses: "published",
    type: "exposition",
    format: "json",
    page: String(page),
  });
  const targetUrl = `${RC_SEARCH_URL}?${params}`;

  // Try direct first, fall back to CORS proxy
  let res;
  try {
    res = await fetch(targetUrl);
  } catch (e) {
    if (!isCorsError(e)) throw e;
    res = await fetch(`${CORS_PROXY}${encodeURIComponent(targetUrl)}`);
  }

  if (!res.ok) throw new Error(`Search returned ${res.status}`);
  return normalizeResults(await res.json());
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

function buildRAGContext(expositions) {
  return expositions.slice(0, 10).map((exp, i) => {
    const author = getAuthorName(exp);
    const kws = getKeywords(exp).slice(0, 8).join(", ");
    const abs = (exp.abstract || exp.description || "").slice(0, 400);
    const id = exp.id || "";
    const pageId = exp["default-page"]?.id || "";
    return [
      `[${i + 1}] "${exp.title || "Untitled"}" — ${author}`,
      exp.created ? `Published: ${exp.created}` : "",
      kws ? `Keywords: ${kws}` : "",
      abs ? `Abstract: ${abs}${abs.length === 400 ? "…" : ""}` : "",
      `URL: https://www.researchcatalogue.net/view/${id}/${pageId}`,
    ].filter(Boolean).join("\n");
  }).join("\n\n---\n\n");
}

async function generateRAGAnswer(apiKey, query, context) {
  const res = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: `You are a knowledgeable research assistant for the Research Catalogue (researchcatalogue.net), an international database for artistic research maintained by the Society for Artistic Research. You help users discover and understand artistic research expositions.

When answering, cite retrieved expositions by their bracket number [N]. Be concise and insightful; highlight connections between works when relevant. Focus on what the expositions reveal about the query topic.`,
      messages: [{
        role: "user",
        content: `Query: "${query}"\n\nRetrieved expositions:\n\n${context}\n\nAnswer the query based on these expositions, citing them by [number].`,
      }],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Claude API error (${res.status})`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || "";
}

function ExpositionCard({ exp, index }) {
  const author = getAuthorName(exp);
  const keywords = getKeywords(exp);
  const abstract = exp.abstract || exp.description || "";
  const id = exp.id || "";
  const pageId = exp["default-page"]?.id || "";
  const url = `https://www.researchcatalogue.net/view/${id}/${pageId}`;
  const thumb = exp.thumbnail || exp["default-page"]?.screenshot;

  return (
    <article className="exp-card">
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
        </div>
        {abstract && (
          <p className="exp-abstract">
            {abstract.length > 240 ? abstract.slice(0, 240) + "…" : abstract}
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

function AnswerPanel({ answer, loading, error }) {
  if (!loading && !error && !answer) return null;
  return (
    <section className="answer-section">
      <h2 className="section-label">AI Answer</h2>
      {loading && <p className="answer-loading">Generating answer…</p>}
      {error && <p className="answer-error">{error}</p>}
      {answer && <div className="answer-body">{answer}</div>}
    </section>
  );
}

const EXAMPLE_QUERIES = [
  "artistic practice as research",
  "sound art and performance",
  "material culture and craft",
  "digital and interactive art",
];

export default function App() {
  const [query, setQuery] = useState("");
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("rc_claude_key") || "");
  const [showSettings, setShowSettings] = useState(false);

  const [expositions, setExpositions] = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");

  const [answer, setAnswer] = useState("");
  const [answerLoading, setAnswerLoading] = useState(false);
  const [answerError, setAnswerError] = useState("");

  const saveKey = (key) => {
    setApiKey(key);
    if (key) localStorage.setItem("rc_claude_key", key);
    else localStorage.removeItem("rc_claude_key");
  };

  const runSearch = useCallback(async (q) => {
    if (!q.trim()) return;
    setSearchLoading(true);
    setSearchError("");
    setAnswer("");
    setAnswerError("");
    setExpositions([]);

    let results = [];
    try {
      results = await fetchExpositions(q);
      setExpositions(results);
    } catch (e) {
      setSearchError(e.message);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(false);

    if (apiKey && results.length > 0) {
      setAnswerLoading(true);
      try {
        const context = buildRAGContext(results);
        const ans = await generateRAGAnswer(apiKey, q, context);
        setAnswer(ans);
      } catch (e) {
        setAnswerError(e.message);
      } finally {
        setAnswerLoading(false);
      }
    }
  }, [apiKey]);

  const handleSubmit = (e) => {
    e.preventDefault();
    runSearch(query);
  };

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
            disabled={searchLoading}
            autoFocus
          />
          <button className="search-btn" type="submit" disabled={searchLoading || !query.trim()}>
            {searchLoading ? "…" : "Search"}
          </button>
          <button
            type="button"
            className={`settings-toggle${showSettings ? " active" : ""}`}
            onClick={() => setShowSettings(s => !s)}
            title="API settings"
          >
            ⚙
          </button>
        </form>

        {showSettings && (
          <div className="settings-panel">
            <label className="settings-label">
              Anthropic API Key <span className="settings-hint">(enables AI-generated answers)</span>
            </label>
            <input
              className="settings-input"
              type="password"
              value={apiKey}
              onChange={e => saveKey(e.target.value)}
              placeholder="sk-ant-api03-…"
              spellCheck={false}
            />
            <p className="settings-note">
              Stored only in your browser's local storage. Without a key, search results are still displayed — just without AI synthesis.
            </p>
          </div>
        )}

        {searchError && <div className="search-error">{searchError}</div>}

        <AnswerPanel answer={answer} loading={answerLoading} error={answerError} />

        {expositions !== null && !searchLoading && (
          <section className="results-section">
            <h2 className="section-label">
              {expositions.length === 0
                ? "No results found"
                : `${expositions.length} exposition${expositions.length !== 1 ? "s" : ""} retrieved`}
            </h2>
            <div className="results-list">
              {expositions.map((exp, i) => (
                <ExpositionCard key={exp.id ?? i} exp={exp} index={i} />
              ))}
            </div>
          </section>
        )}

        {expositions === null && !searchLoading && (
          <div className="landing">
            <p className="landing-lead">
              Query thousands of artistic research expositions from the{" "}
              <a href="https://www.researchcatalogue.net" target="_blank" rel="noopener noreferrer">
                Research Catalogue
              </a>
              .
            </p>
            <p className="landing-sub">Try one of these:</p>
            <div className="example-list">
              {EXAMPLE_QUERIES.map(q => (
                <button key={q} className="example-btn" onClick={() => { setQuery(q); runSearch(q); }}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
      </main>

      <footer className="app-footer">
        Data:{" "}
        <a href="https://www.researchcatalogue.net" target="_blank" rel="noopener noreferrer">
          Research Catalogue
        </a>
        {" · "}
        <a href="https://rcdata.org" target="_blank" rel="noopener noreferrer">
          RCData
        </a>
        {" · "}
        Society for Artistic Research
      </footer>
    </div>
  );
}
