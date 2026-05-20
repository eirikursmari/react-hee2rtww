import React, { useState, useCallback } from "react";
import "./style.css";

const RC_SEARCH_URL = "https://www.researchcatalogue.net/portal/search-result";
const RC_CONTENT_URL = "https://map.rcdata.org/rcjson/expo";
const CORS_PROXY = "https://corsproxy.io/?";
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = "claude-sonnet-4-6";
const DEEP_SEARCH_LIMIT = 5;   // expositions to fetch full content for
const DEEP_TEXT_LIMIT = 2500;  // chars of body text per exposition sent to Claude

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

async function proxiedFetch(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    if (!isCorsError(e)) throw e;
    res = await fetch(`${CORS_PROXY}${encodeURIComponent(url)}`);
  }
  return res;
}

async function fetchExpositions(query, page = 0) {
  const params = new URLSearchParams({
    fulltext: query,
    statuses: "published",
    type: "exposition",
    format: "json",
    page: String(page),
  });
  const res = await proxiedFetch(`${RC_SEARCH_URL}?${params}`);
  if (!res.ok) throw new Error(`Search returned ${res.status}`);
  return normalizeResults(await res.json());
}

async function fetchExpositionContent(id) {
  const res = await proxiedFetch(`${RC_CONTENT_URL}/${id}`);
  if (!res.ok) throw new Error(`Content fetch returned ${res.status}`);
  return res.json();
}

function stripHtml(html) {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = html;
  return (div.textContent || div.innerText || "").replace(/\s+/g, " ").trim();
}

function extractText(data) {
  if (!data || !Array.isArray(data.tools)) return "";
  return data.tools
    .filter(t => t.tool_type === "tool-text" || t.tool_type === "tool-simpletext")
    .map(t => stripHtml(t.content || ""))
    .filter(Boolean)
    .join("\n\n");
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
  const id = exp.id || "";
  const pageId = exp["default-page"]?.id || exp.defaultPage?.id || exp["default_page"]?.id || "";
  if (id && pageId) return `https://www.researchcatalogue.net/view/${id}/${pageId}`;
  if (id) return `https://www.researchcatalogue.net/view/${id}`;
  return "https://www.researchcatalogue.net";
}

function buildContext(expositions, contentMap = {}) {
  const deep = Object.keys(contentMap).length > 0;
  const limit = deep ? DEEP_SEARCH_LIMIT : 10;
  return expositions.slice(0, limit).map((exp, i) => {
    const author = getAuthorName(exp);
    const kws = getKeywords(exp).slice(0, 8).join(", ");
    const abs = (exp.abstract || exp.description || "").slice(0, 300);
    const bodyText = contentMap[exp.id] || "";
    return [
      `[${i + 1}] "${exp.title || "Untitled"}" — ${author}`,
      exp.created ? `Published: ${exp.created}` : "",
      kws ? `Keywords: ${kws}` : "",
      abs ? `Abstract: ${abs}` : "",
      bodyText
        ? `Full content:\n${bodyText.slice(0, DEEP_TEXT_LIMIT)}${bodyText.length > DEEP_TEXT_LIMIT ? "…" : ""}`
        : "",
      `URL: ${getExpositionUrl(exp)}`,
    ].filter(Boolean).join("\n");
  }).join("\n\n---\n\n");
}

async function generateRAGAnswer(apiKey, query, context, deep) {
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
      max_tokens: deep ? 2048 : 1024,
      system: `You are a knowledgeable research assistant for the Research Catalogue (researchcatalogue.net), an international database for artistic research maintained by the Society for Artistic Research. You help users discover and understand artistic research expositions.

When answering, cite retrieved expositions by their bracket number [N]. Be concise and insightful; highlight connections between works when relevant.${deep ? " You have access to the full text content of each exposition — use it to give detailed, specific answers." : ""}`,
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
  const url = getExpositionUrl(exp);
  const thumb = exp.thumbnail || exp["default-page"]?.screenshot || exp.screenshot;

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

function AnswerPanel({ answer, loading, loadingMsg, error }) {
  if (!loading && !loadingMsg && !error && !answer) return null;
  return (
    <section className="answer-section">
      <h2 className="section-label">AI Answer</h2>
      {loadingMsg && <p className="answer-loading">{loadingMsg}</p>}
      {loading && !loadingMsg && <p className="answer-loading">Generating answer…</p>}
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
  const [deepSearch, setDeepSearch] = useState(() => localStorage.getItem("rc_deep_search") === "1");

  const [expositions, setExpositions] = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");

  const [answer, setAnswer] = useState("");
  const [answerLoading, setAnswerLoading] = useState(false);
  const [answerError, setAnswerError] = useState("");
  const [loadingMsg, setLoadingMsg] = useState("");

  const saveKey = (key) => {
    setApiKey(key);
    if (key) localStorage.setItem("rc_claude_key", key);
    else localStorage.removeItem("rc_claude_key");
  };

  const toggleDeepSearch = (val) => {
    setDeepSearch(val);
    localStorage.setItem("rc_deep_search", val ? "1" : "");
  };

  const runSearch = useCallback(async (q, deep = deepSearch) => {
    if (!q.trim()) return;
    setSearchLoading(true);
    setSearchError("");
    setAnswer("");
    setAnswerError("");
    setLoadingMsg("");
    setExpositions([]);

    let results = [];
    try {
      results = await fetchExpositions(q);
      if (results.length > 0) console.log("RC API first result:", results[0]);
      setExpositions(results);
    } catch (e) {
      setSearchError(e.message);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(false);

    if (!apiKey || results.length === 0) return;

    setAnswerLoading(true);
    try {
      let context;
      if (deep && results.length > 0) {
        const top = results.slice(0, DEEP_SEARCH_LIMIT);
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
        setLoadingMsg("Generating answer…");
        context = buildContext(results, contentMap);
      } else {
        setLoadingMsg("");
        context = buildContext(results);
      }

      const ans = await generateRAGAnswer(apiKey, q, context, deep);
      setAnswer(ans);
    } catch (e) {
      setAnswerError(e.message);
    } finally {
      setAnswerLoading(false);
      setLoadingMsg("");
    }
  }, [apiKey, deepSearch]);

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
            disabled={searchLoading || answerLoading}
            autoFocus
          />
          <button className="search-btn" type="submit" disabled={searchLoading || answerLoading || !query.trim()}>
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

        <div className="search-options">
          <label className="deep-toggle">
            <input
              type="checkbox"
              checked={deepSearch}
              onChange={e => toggleDeepSearch(e.target.checked)}
            />
            <span className="deep-label">Deep search</span>
            <span className="deep-hint"> — reads full exposition content, not just abstracts (slower)</span>
          </label>
        </div>

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

        <AnswerPanel
          answer={answer}
          loading={answerLoading}
          loadingMsg={loadingMsg}
          error={answerError}
        />

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
