# PADI Sovereign Bureau: Living Library of Access

> *A Deterministic Substrate for Illuminating Marginalized Technological Voices.*

[![WeCoded 2026](https://img.shields.io/badge/DEV-WeCoded%202026-a855f7?style=flat-square)](https://dev.to/challenges/wecoded-2026)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-3b82f6?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-v18%2B-10b981?style=flat-square)](https://nodejs.org)
[![DOI](https://img.shields.io/badge/DOI-10.5281%2Fzenodo.18894084-ec4899?style=flat-square)](https://doi.org/10.5281/zenodo.18894084)

---

## 🏛️ Executive Summary

The PADI Sovereign Bureau is a high-integrity information science infrastructure designed to address the systemic marginalization of technological contributions. While mainstream tech narratives leave "shadow voices" behind, this system provides a **Sovereign Source of Truth** — an append-only, deterministic ledger that quantifies and visualizes influence through the PADI Technical Standard.

This is not a social graph. It is an **audit trail for human knowledge**.

---

## ⚖️ Why This Exists

This project was built for the [DEV WeCoded 2026 Contest](https://dev.to/challenges/wecoded-2026) on Equity in Tech.

The standard history of technology is incomplete. Contributions from women, Black scientists, and other marginalized groups are consistently underrepresented in the canonical record — not because the contributions were minor, but because the infrastructure for remembering them was never built.

The Living Library of Access addresses this by:

1. **Restoring Agency** — a locally-owned data ledger, free from extractive platforms and algorithmic curation
2. **Illuminating Shadows** — explicitly categorizing and scoring contributions across Computing, Mathematics, Systems, AI Ethics, Justice, and Medicine
3. **Mathematical Integrity** — using open graph theory to prove influence, rather than popularity or engagement metrics

---

## 🛡️ Architecture (v14.2 FINAL)

This repository implements a **Hardened Monolith** design, prioritizing data sovereignty and auditability over transient cloud dependencies.

```
Contributor → POST /event → Sovereign Engine → NDJSON Log
                                    ↓
                             In-Memory Graph
                                    ↓
                    GET /graph ← Liaison UI (D3 + WebSocket)
                    GET /influence  ← BFS Influence Scores
                    WS connection   ← Live re-render on new voices
```

### Files

| File | Role |
|---|---|
| `index.html` | Liaison UI — D3 force graph, live-synced via WebSocket, static fallback built in |
| `padi_engine_server.js` | Sovereign Engine — Node.js event-sourced graph server |
| `living_library_mvs_architecture.html` | Interactive repository map with per-file annotations |
| `padi_engine_visualizer.html` | Engine layer diagram — click any component for detail |

### Key Engineering Decisions

**NDJSON Event Log** — each event is one appended line (`O(1)` write). No full-file reread on every submission. Corrupt lines are skipped on recovery without crashing.

**Path-Aware BFS** — influence scores accumulate per traversal path, not per node. A well-connected voice reached via three paths scores `3 × decay²` rather than `decay²` once. This removes the single-path bias of a standard visited-set BFS.

**Event Queue** — all writes are serialized through a drain loop, preventing `lastEventIndex` drift under concurrent submissions.

**Atomic Snapshots** — state is written to a `.tmp` file then renamed, ensuring no partial writes survive a power loss. Snapshots trigger on both `SIGINT` and `SIGTERM` — covering local ctrl+c and cloud platform restarts.

**Boundary Force** — a custom D3 force clamps all nodes within the visible viewport on every simulation tick. No node escapes off-screen regardless of repulsion strength.

**Graceful Fallback** — the Liaison UI detects server availability on load using a cross-browser `AbortController` timeout (Safari-compatible). If the engine is offline, it renders the full static graph from the embedded archive of 23 founding voices. No blank screen.

**Incremental WebSocket Updates** — on receiving a live `UPDATE` event, the frontend only triggers a full re-render if new nodes have actually been added, preserving zoom state and node positions during routine updates.

---

## 🚀 Getting Started

### Prerequisites

- Node.js v18+
- npm

### Run the Sovereign Engine

```bash
# Install WebSocket dependency
npm install ws

# Start the engine
node padi_engine_server.js
```

The engine starts on `http://localhost:8080` and serves `index.html` at `/`.

### Open the Liaison UI

Open `index.html` directly in any browser, or navigate to `http://localhost:8080` after starting the engine.

- **Server running** → fetches live graph, sizes nodes by BFS influence score, enables the `+ ADD VOICE` form, connects WebSocket for live updates
- **Server offline** → renders full static graph with all 23 founding voices, no blank screen

### API Endpoints

```bash
# Health check
curl http://localhost:8080/health

# Full graph state
curl http://localhost:8080/graph

# All influence scores
curl http://localhost:8080/influence

# Influence traversal from a specific node
curl http://localhost:8080/influence/h-01

# Add a new voice
curl -X POST http://localhost:8080/event \
  -H "Content-Type: application/json" \
  -d '{"type":"NODE_ADDED","data":{"id":"v-example","name":"Example Voice","category":"Justice","bio":"Key contribution."}}'
```

### Environment Variables

```bash
PORT=8080                                        # Default server port
ALLOWED_ORIGINS=https://yourdomain.github.io     # CORS allowlist (default: *)
```

---

## 📡 WebSocket Protocol

Connect to `ws://localhost:8080` to receive live updates.

```javascript
const ws = new WebSocket('ws://localhost:8080');

ws.onmessage = e => {
  const msg = JSON.parse(e.data);

  if (msg.type === 'INIT')   renderGraph(msg.graph);  // full state on connect
  if (msg.type === 'UPDATE') refreshGraph(msg.event); // incremental on new event
};
```

---

## 🚢 Deployment

### GitHub Pages (static, no server)

Enable GitHub Pages on the `main` branch root. The `index.html` file runs in full offline mode — all 23 founding voices render from the embedded archive. The `+ ADD VOICE` form is hidden automatically when no server is detected.

### Render / Railway / Fly.io (full server mode)

Deploy `padi_engine_server.js` as a Node.js web service. Set the `ALLOWED_ORIGINS` environment variable to your frontend domain. The server handles WebSocket upgrades, serves `index.html` at `/`, and exposes all API endpoints.

```bash
# Set on your cloud platform dashboard
ALLOWED_ORIGINS=https://peculiarlibrarian.github.io
PORT=8080
```

> **Note:** Free-tier Render instances spin down after inactivity. Expect a ~30 second cold start on first connection. The frontend handles this gracefully by falling back to static mode during the timeout.

---

## 📜 Metadata Standard

Registered under **DOI: [10.5281/zenodo.18894084](https://doi.org/10.5281/zenodo.18894084)**

This project is an implementation of the **Practice-Area Depth Index (PADI)** — a semantic architecture for automated authority scoring across knowledge domains.

| Field | Value |
|---|---|
| Architect | Samuel Muriithi Gitandu (The Peculiar Librarian) |
| Bureau Node | Nairobi-01 (Node N-1) |
| Standard | PADI Technical Standard v14.2 |
| License | Apache 2.0 |

---

## 🗺️ Roadmap

The Living Library is designed to grow. The current architecture supports three evolutionary phases:

| Phase | Status | Description |
|---|---|---|
| 1 — Static Foundation | ✅ Complete | 23 founding voices, D3 visualization, PADI engine |
| 2 — Live Contributions | ✅ Complete | WebSocket sync, `POST /event` API, BFS influence scoring |
| 3 — Web Submission UI | 🔄 Next | `/contribute` form, PR automation, voice schema validation |
| 4 — Headless CMS | 📋 Planned | Contentful/DatoCMS integration, webhook-triggered rebuilds |
| 5 — Sovereign Hosting | 📋 Planned | Vercel/Netlify migration, SSR, curator auth |

---

## 🤝 Contributing

Want to add a voice to the library?

1. Fork the repository
2. Add your voice entry to `index.html` under `FALLBACK_NODES` following the schema:

```json
{
  "id": "unique-id",
  "name": "Full Name",
  "category": "Computing | Mathematics | Systems | AI Ethics | Justice | Medicine",
  "bio": "One-sentence contribution summary.",
  "status": "illuminated"
}
```

3. Open a Pull Request with the title: `New Voice: [Full Name]`

*Equity impact rubric and full contribution guidelines coming in Phase 3.*

---

*"The best library isn't just about beautiful books — it's about how easily new books can be added, discovered, and preserved. A static collection is a museum. A living library has clear systems for growth."*
