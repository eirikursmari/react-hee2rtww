import React from "react";
import "./style.css";

export default function App() {
  return (
    <div>
      <h1>Hello StackBlitz!</h1>
      <p>Start editing to see some magic happen :)</p>
    </div>
  );
}
import { useState } from "react";

const mannNodes = [
  { id: "person", label: "Manneskja", sub: "Miðpunkturinn", x: 50, y: 50, size: 52, main: true },
  { id: "census", label: "Manntöl", sub: "1703–1920", x: 50, y: 14, size: 38 },
  { id: "smb", label: "SMB", sub: "Sögulegt mann- og bæjatal", x: 79, y: 28, size: 36 },
  { id: "farm", label: "Bæir & Jarðir", sub: "Jarðabók 1702–14", x: 82, y: 57, size: 34 },
  { id: "church", label: "Kirkjubækur", sub: "Skírn · Giftingar · Dauðar", x: 65, y: 80, size: 32 },
  { id: "isl", label: "Íslendingabók", sub: "Ættfræðitenging", x: 35, y: 82, size: 34 },
  { id: "geo", label: "Örnefni & Kort", sub: "GeoNames · staðsetning", x: 18, y: 60, size: 30 },
  { id: "wikidata", label: "Wikidata", sub: "Alþjóðleg tenging", x: 16, y: 32, size: 28 },
  { id: "kvenna", label: "Kvennaspor", sub: "Rannsóknarverkefni", x: 50, y: 33, size: 26, secondary: true },
];

const mannEdges = [
  ["person", "census", "skráð í"],
  ["person", "smb", "tengd með SMB"],
  ["person", "church", "lífsatvik"],
  ["person", "isl", "ættartenging"],
  ["person", "farm", "bjó á"],
  ["census", "smb", "grunnur"],
  ["smb", "geo", "staðsetning"],
  ["farm", "geo", "kortlagður"],
  ["isl", "wikidata", "tengdur"],
  ["person", "wikidata", "ef þekkt"],
  ["smb", "kvenna", "innviður"],
  ["census", "kvenna", "gögn"],
];

const listaNodes = [
  { id: "artwork", label: "Listaverk", sub: "Miðpunkturinn", x: 50, y: 50, size: 52, main: true },
  { id: "artist", label: "Listamaður", sub: "Ævisaga · menntun", x: 50, y: 13, size: 40 },
  { id: "museum", label: "Safneignin", sub: "LSÍ · LSR · LSA", x: 80, y: 27, size: 36 },
  { id: "exhibition", label: "Sýningar", sub: "Sýningaskrár · dagsetningar", x: 84, y: 55, size: 34 },
  { id: "photo", label: "Ljósmyndir", sub: "Sarpur · skjalasjóður", x: 65, y: 80, size: 30 },
  { id: "press", label: "Fréttir & Gagnrýni", sub: "Tímarit.is · dagblöð", x: 36, y: 83, size: 32 },
  { id: "poster", label: "Veggspjöld", sub: "Auglýsingarefni", x: 17, y: 62, size: 28 },
  { id: "letters", label: "Bréf & Skjöl", sub: "Einkasamlagnir", x: 15, y: 35, size: 26 },
  { id: "smb2", label: "ManntölSampo", sub: "Ævisögutengsl", x: 50, y: 32, size: 26, secondary: true },
];

const listaEdges = [
  ["artwork", "artist", "búið til af"],
  ["artwork", "museum", "varðveitt í"],
  ["artwork", "exhibition", "sýnt á"],
  ["artwork", "photo", "myndsett"],
  ["artwork", "press", "gagnrýnt"],
  ["artist", "letters", "skrifaði"],
  ["artist", "smb2", "ævisögutengsl"],
  ["exhibition", "poster", "kynnt með"],
  ["exhibition", "press", "fjallað um"],
  ["exhibition", "photo", "skráð með"],
  ["museum", "exhibition", "hýsti"],
  ["letters", "artwork", "lýsir"],
];

const theme = {
  bg: "#ffffff",
  font: "Georgia, serif",
  titleColor: "#000000",
  mainFill: "#000000",
  mainStroke: "#000000",
  mainText: "#ffffff",
  nodeFill: "#ffffff",
  nodeStroke: "#000000",
  nodeText: "#000000",
  secFill: "#f0f0f0",
  secStroke: "#000000",
  subText: "#444444",
  edge: "#000000",
  edgeActive: "#000000",
  panelBg: "rgba(255,255,255,0.95)",
  panelBorder: "#000000",
};

function SampoGraph({ nodes, edges, title, description }) {
  const [hovered, setHovered] = useState(null);
  const [selected, setSelected] = useState(null);

  const connected = hovered
    ? new Set(edges.flatMap(e => e[0] === hovered || e[1] === hovered ? [e[0], e[1]] : []))
    : new Set();

  const activeNode = selected
    ? nodes.find(n => n.id === selected)
    : nodes.find(n => n.main);

  const activeEdges = activeNode
    ? edges.filter(e => e[0] === activeNode.id || e[1] === activeNode.id)
    : [];

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      {/* Title */}
      <div style={{ position: "absolute", top: 18, left: 22, zIndex: 10, fontFamily: theme.font }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: theme.titleColor, letterSpacing: "-0.02em", lineHeight: 1 }}>
          {title}
        </div>
        <div style={{ fontSize: 11, color: theme.titleColor, opacity: 0.5, marginTop: 5, maxWidth: 240 }}>
          {description}
        </div>
      </div>

      {/* Info panel */}
      {activeNode && (
        <div style={{
          position: "absolute", bottom: 18, right: 18, zIndex: 10,
          background: theme.panelBg,
          border: `1px solid ${theme.panelBorder}`,
          borderRadius: 6, padding: "10px 14px", maxWidth: 210,
          fontFamily: theme.font,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: theme.titleColor }}>{activeNode.label}</div>
          <div style={{ fontSize: 10, color: theme.titleColor, opacity: 0.55, marginTop: 3 }}>{activeNode.sub}</div>
          <div style={{ fontSize: 9, color: theme.titleColor, opacity: 0.45, marginTop: 8, lineHeight: 1.7 }}>
            {activeEdges.map((e, i) => {
              const otherId = e[0] === activeNode.id ? e[1] : e[0];
              const other = nodes.find(n => n.id === otherId);
              const rel = e[0] === activeNode.id ? `→ ${e[2]}` : `← ${e[2]}`;
              return <div key={i}>{rel}: <strong>{other?.label}</strong></div>;
            })}
          </div>
        </div>
      )}

      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        {/* Edges */}
        {edges.map((edge, i) => {
          const from = nodes.find(n => n.id === edge[0]);
          const to = nodes.find(n => n.id === edge[1]);
          if (!from || !to) return null;
          const isActive = hovered ? (edge[0] === hovered || edge[1] === hovered) : false;
          const dim = hovered && !isActive;
          return (
            <line key={i}
              x1={`${from.x}%`} y1={`${from.y}%`}
              x2={`${to.x}%`} y2={`${to.y}%`}
              stroke={theme.edge}
              strokeWidth={isActive ? 2 : 1}
              strokeDasharray={isActive ? "none" : "5 4"}
              style={{ opacity: dim ? 0.08 : isActive ? 1 : 0.3, transition: "opacity 0.25s" }}
            />
          );
        })}

        {/* Nodes */}
        {nodes.map(node => {
          const isHov = hovered === node.id;
          const isCon = connected.has(node.id);
          const dim = hovered && !isHov && !isCon;
          const fill = node.main ? theme.mainFill : node.secondary ? theme.secFill : theme.nodeFill;
          const stroke = theme.nodeStroke;
          const textCol = node.main ? theme.mainText : theme.nodeText;
          return (
            <g key={node.id}
              style={{ cursor: "pointer", opacity: dim ? 0.15 : 1, transition: "opacity 0.25s" }}
              onClick={() => setSelected(selected === node.id ? null : node.id)}
              onMouseEnter={() => setHovered(node.id)}
              onMouseLeave={() => setHovered(null)}
            >
              <circle
                cx={`${node.x}%`} cy={`${node.y}%`}
                r={node.size / 2 + (isHov ? 3 : 0)}
                fill={fill}
                stroke={stroke}
                strokeWidth={node.main ? 2.5 : isHov ? 2.5 : 1.5}
                style={{ transition: "r 0.2s" }}
              />
              <text
                x={`${node.x}%`} y={`${node.y}%`}
                textAnchor="middle" dy="-3"
                fontSize={node.main ? 11 : 9}
                fontWeight="700"
                fill={textCol}
                fontFamily={theme.font}
                style={{ pointerEvents: "none", userSelect: "none" }}
              >{node.label}</text>
              <text
                x={`${node.x}%`} y={`${node.y}%`}
                textAnchor="middle" dy="9"
                fontSize={6.5}
                fill={node.main ? "#ffffff" : theme.subText}
                fontFamily={theme.font}
                style={{ pointerEvents: "none", userSelect: "none" }}
              >{node.sub}</text>
            </g>
          );
        })}
      </svg>

      {/* Hint */}
      <div style={{
        position: "absolute", bottom: 18, left: 22,
        fontSize: 10, fontFamily: theme.font,
        color: theme.titleColor, opacity: 0.3,
      }}>
        Haltu yfir hnút · Smelltu til að læsa
      </div>
    </div>
  );
}

export default function App() {
  const [active, setActive] = useState(0);

  const graphs = [
    {
      nodes: mannNodes, edges: mannEdges,
      title: "Manntöl",
      description: "Tenging manntalsgagna 1703–1920 við sögulegar heimildir"
    },
    {
      nodes: listaNodes, edges: listaEdges,
      title: "Listir",
      description: "Tenging listaverka við menningarlegt samhengi"
    },
  ];

  const g = graphs[active];

  return (
    <div style={{
      width: "100vw", height: "100vh", overflow: "hidden",
      background: "#ffffff",
      fontFamily: theme.font,
    }}>
      {/* Tabs */}
      <div style={{ position: "absolute", top: 18, right: 18, zIndex: 20, display: "flex", gap: 8 }}>
        {graphs.map((gr, i) => (
          <button key={i} onClick={() => setActive(i)} style={{
            padding: "6px 14px",
            fontFamily: theme.font,
            fontSize: 12,
            fontWeight: active === i ? 700 : 400,
            background: active === i ? "#000000" : "#ffffff",
            color: active === i ? "#ffffff" : "#000000",
            border: "1px solid #000000",
            borderRadius: 4,
            cursor: "pointer",
            transition: "all 0.2s",
          }}>{gr.title}</button>
        ))}
      </div>

      <SampoGraph key={active} {...g} />
    </div>
  );
}
