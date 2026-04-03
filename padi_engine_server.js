// =====================================================
// PADI SOVEREIGN BUREAU — Production Graph Server
// Version: 14.2 (Production UI + API Hybrid)
// Author: Samuel Muriithi Gitandu (The Peculiar Librarian)
// =====================================================

'use strict';

const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');
const { URL }   = require('url');

const CONFIG = {
  PORT:                 process.env.PORT || 10000, 
  EVENT_LOG_PATH:       path.join(__dirname, 'event_log.ndjson'),
  SNAPSHOT_PATH:        path.join(__dirname, 'snapshot.json'),
  SNAPSHOT_INTERVAL_MS: 15000,
  MAX_EVENT_SIZE_BYTES: 1_000_000,
  BFS_MAX_DEPTH:        5,
  DECAY_FACTOR:         0.6,
  ALLOWED_ORIGINS:      ['*']
};

// --- Storage Logic ---
const Storage = {
  appendEvent(event) {
    fs.appendFileSync(CONFIG.EVENT_LOG_PATH, JSON.stringify(event) + '\n', 'utf-8');
  },
  loadEventLog() {
    if (!fs.existsSync(CONFIG.EVENT_LOG_PATH)) return [];
    return fs.readFileSync(CONFIG.EVENT_LOG_PATH, 'utf-8')
      .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  },
  saveSnapshot(data) {
    fs.writeFileSync(CONFIG.SNAPSHOT_PATH, JSON.stringify(data, null, 2));
  }
};

// --- State Engine ---
const State = {
  nodes: new Map(),
  edges: new Map(),
  lastEventIndex: -1
};

function applyEvent(event) {
  if (event.type === 'NODE_ADDED') {
    const { id, ...meta } = event.data;
    if (!State.nodes.has(id)) {
      State.nodes.set(id, { id, ...meta });
      State.edges.set(id, new Set());
    }
  }
  if (event.type === 'EDGE_ADDED') {
    const { from, to } = event.data;
    if (State.nodes.has(from) && State.nodes.has(to)) {
      State.edges.get(from).add(to);
    }
  }
}

function computeInfluence() {
  const scores = {};
  for (const nodeId of State.nodes.keys()) {
    let score = 1.0; 
    const neighbors = State.edges.get(nodeId) || new Set();
    score += neighbors.size * CONFIG.DECAY_FACTOR;
    scores[nodeId] = Math.round(score * 1000) / 1000;
  }
  return scores;
}

// --- Server & Routing ---
const wss = new WebSocket.Server({ noServer: true });
const clients = new Set();

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathName = parsedUrl.pathname;
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }

  // Serve Frontend
  if (req.method === 'GET' && (pathName === '/' || pathName === '/index.html')) {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); return res.end("index.html not found"); }
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // API Endpoints
  if (pathName === '/graph') {
    res.writeHead(200, headers);
    return res.end(JSON.stringify({
      nodes: Array.from(State.nodes.values()),
      edges: Array.from(State.edges.entries()).map(([from, to]) => ({ from, to: Array.from(to) }))
    }));
  }

  if (pathName === '/influence') {
    res.writeHead(200, headers);
    return res.end(JSON.stringify({ scores: computeInfluence() }));
  }

  if (req.method === 'POST' && pathName === '/event') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const event = JSON.parse(body);
      Storage.appendEvent(event);
      applyEvent(event);
      State.lastEventIndex++;
      clients.forEach(c => c.send(JSON.stringify({ type: 'UPDATE' })));
      res.writeHead(200, headers);
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  res.writeHead(404, headers); res.end(JSON.stringify({ error: 'Not Found' }));
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
  });
});

server.listen(CONFIG.PORT, () => console.log(`Bureau Live on ${CONFIG.PORT}`));
