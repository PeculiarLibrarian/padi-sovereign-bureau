// =====================================================
// PADI SOVEREIGN BUREAU — Production Graph Server
// Version: 14.1 (Integrated UI Routing)
// Run: node padi_engine_server.js
// Requires: npm install ws
// =====================================================

'use strict';

const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');
const { URL }   = require('url');

// =====================================================
// CONFIGURATION
// =====================================================
const CONFIG = {
  PORT:                 process.env.PORT || 10000,
  EVENT_LOG_PATH:       path.join(__dirname, 'event_log.ndjson'),
  SNAPSHOT_PATH:        path.join(__dirname, 'snapshot.json'),
  SNAPSHOT_INTERVAL_MS: 15000,
  MAX_EVENT_SIZE_BYTES: 1_000_000,
  BFS_MAX_DEPTH:        5,
  DECAY_FACTOR:         0.6,
  ALLOWED_ORIGINS:      process.env.ALLOWED_ORIGINS
                          ? process.env.ALLOWED_ORIGINS.split(',')
                          : ['*']
};

// =====================================================
// UTILITY & STORAGE
// =====================================================
function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function corsHeaders(origin) {
  const allow = CONFIG.ALLOWED_ORIGINS.includes('*') || CONFIG.ALLOWED_ORIGINS.includes(origin)
    ? origin || '*'
    : '';
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

const Storage = {
  appendEvent(event) {
    const line = JSON.stringify(event) + '\n';
    fs.appendFileSync(CONFIG.EVENT_LOG_PATH, line, 'utf-8');
  },
  loadEventLog() {
    if (!fs.existsSync(CONFIG.EVENT_LOG_PATH)) return [];
    return fs.readFileSync(CONFIG.EVENT_LOG_PATH, 'utf-8')
      .split('\n')
      .filter(l => l.trim().length > 0)
      .map(safeJsonParse)
      .filter(Boolean);
  },
  loadSnapshot() {
    if (!fs.existsSync(CONFIG.SNAPSHOT_PATH)) return null;
    return safeJsonParse(fs.readFileSync(CONFIG.SNAPSHOT_PATH, 'utf-8'));
  },
  saveSnapshot(snapshot) {
    atomicWrite(CONFIG.SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  }
};

// =====================================================
// STATE & REASONING
// =====================================================
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
      if (!State.edges.has(from)) State.edges.set(from, new Set());
      State.edges.get(from).add(to);
    }
  }
}

function computeAllInfluence() {
  const result = {};
  for (const nodeId of State.nodes.keys()) {
    // Simple degree-based fallback for global influence
    result[nodeId] = (State.edges.get(nodeId)?.size || 0) * CONFIG.DECAY_FACTOR;
  }
  return result;
}

// =====================================================
// RECOVERY & SNAPSHOT
// =====================================================
function recoverState() {
  const snapshot = Storage.loadSnapshot();
  const events   = Storage.loadEventLog();
  let startIndex = 0;

  if (snapshot) {
    State.nodes.clear();
    State.edges.clear();
    (snapshot.nodes || []).forEach(n => State.nodes.set(n.id, n));
    (snapshot.edges || []).forEach(([k, v]) => State.edges.set(k, new Set(v)));
    State.lastEventIndex = snapshot.lastEventIndex;
    startIndex = snapshot.lastEventIndex + 1;
  }

  for (let i = startIndex; i < events.length; i++) {
    applyEvent(events[i]);
    State.lastEventIndex = i;
  }
  console.log(`[RECOVERY] Replayed to index ${State.lastEventIndex}. Graph: ${State.nodes.size} nodes.`);
}

function createSnapshot() {
  const nodesArr = Array.from(State.nodes.values());
  const edgesArr = Array.from(State.edges.entries()).map(([k, v]) => [k, Array.from(v)]);
  Storage.saveSnapshot({ nodes: nodesArr, edges: edgesArr, lastEventIndex: State.lastEventIndex, timestamp: Date.now() });
}

// =====================================================
// BROADCAST & QUEUE
// =====================================================
const wss = new WebSocket.Server({ noServer: true });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); });
}

const EventQueue = {
  _processing: false,
  _queue: [],
  enqueue(event, cb) { this._queue.push({ event, cb }); this._drain(); },
  _drain() {
    if (this._processing || this._queue.length === 0) return;
    this._processing = true;
    const { event, cb } = this._queue.shift();
    try {
      Storage.appendEvent(event);
      applyEvent(event);
      State.lastEventIndex++;
      broadcast({ type: 'UPDATE', lastEventIndex: State.lastEventIndex });
      cb({ success: true });
    } catch (e) { cb({ success: false, error: e.message }); }
    this._processing = false;
    this._drain();
  }
};

// =====================================================
// HTTP SERVER
// =====================================================
const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathName = parsedUrl.pathname;

  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }

  // --- UI ROUTE: Serve index.html at root ---
  if (req.method === 'GET' && (pathName === '/' || pathName === '/index.html')) {
    const htmlPath = path.join(__dirname, 'index.html');
    fs.readFile(htmlPath, (err, data) => {
      if (err) {
        res.writeHead(404, headers);
        return res.end(JSON.stringify({ error: 'UI file (index.html) not found.' }));
      }
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // --- API: Health ---
  if (req.method === 'GET' && pathName === '/health') {
    res.writeHead(200, headers);
    return res.end(JSON.stringify({ status: 'ok', nodes: State.nodes.size, uptime: process.uptime() }));
  }

  // --- API: Graph ---
  if (req.method === 'GET' && pathName === '/graph') {
    res.writeHead(200, headers);
    return res.end(JSON.stringify({
      nodes: Array.from(State.nodes.values()),
      edges: Array.from(State.edges.entries()).map(([from, to]) => ({ from, to: Array.from(to) }))
    }));
  }

  // --- API: Influence ---
  if (req.method === 'GET' && pathName === '/influence') {
    res.writeHead(200, headers);
    return res.end(JSON.stringify({ scores: computeAllInfluence() }));
  }

  // --- API: Post Event ---
  if (req.method === 'POST' && pathName === '/event') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const event = safeJsonParse(body);
      if (!event) { res.writeHead(400, headers); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
      EventQueue.enqueue(event, (result) => {
        res.writeHead(result.success ? 200 : 500, headers);
        res.end(JSON.stringify(result));
      });
    });
    return;
  }

  res.writeHead(404, headers);
  res.end(JSON.stringify({ error: 'Route not found' }));
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function start() {
  recoverState();
  setInterval(createSnapshot, CONFIG.SNAPSHOT_INTERVAL_MS);
  server.listen(CONFIG.PORT, () => console.log(`[PADI] Live on port ${CONFIG.PORT}`));
}

start();
