// =====================================================
// PADI SOVEREIGN BUREAU — Production Graph Server
// Version: 14.2 FINAL
// Run: node padi_engine_server.js
// Requires: npm install ws
// =====================================================

'use strict';

const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');

// =====================================================
// CONFIGURATION
// =====================================================
const CONFIG = {
  PORT:                 process.env.PORT || 8080,
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
// UTILITY
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
  const allow =
    CONFIG.ALLOWED_ORIGINS.includes('*') ||
    CONFIG.ALLOWED_ORIGINS.includes(origin)
      ? origin || '*'
      : '';
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

// =====================================================
// STORAGE  (NDJSON append-only log)
// =====================================================
const Storage = {
  appendEvent(event) {
    const line = JSON.stringify(event) + '\n';
    fs.appendFileSync(CONFIG.EVENT_LOG_PATH, line, 'utf-8');
  },

  loadEventLog() {
    if (!fs.existsSync(CONFIG.EVENT_LOG_PATH)) return [];
    const lines = fs.readFileSync(CONFIG.EVENT_LOG_PATH, 'utf-8')
      .split('\n')
      .filter(l => l.trim().length > 0);
    const events = [];
    for (const line of lines) {
      const parsed = safeJsonParse(line);
      if (parsed) events.push(parsed);
    }
    return events;
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
// VALIDATION
// =====================================================
function validateEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (typeof event.type !== 'string')       return false;
  if (!event.data || typeof event.data !== 'object') return false;

  if (event.type === 'NODE_ADDED') {
    return typeof event.data.id === 'string' && event.data.id.trim().length > 0;
  }
  if (event.type === 'EDGE_ADDED') {
    return (
      typeof event.data.from === 'string' &&
      typeof event.data.to   === 'string' &&
      event.data.from !== event.data.to
    );
  }
  return false;
}

// =====================================================
// STATE (in-memory graph)
// =====================================================
const State = {
  nodes:          new Map(),
  edges:          new Map(),
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
    if (!State.nodes.has(from) || !State.nodes.has(to)) {
      console.warn(`[EDGE_ADDED] skipped — node(s) missing: ${from} -> ${to}`);
      return;
    }
    if (!State.edges.has(from)) State.edges.set(from, new Set());
    State.edges.get(from).add(to);
  }
}

// =====================================================
// REASONING ENGINE  (BFS multi-hop influence)
// =====================================================
function computeInfluence(startNodeId) {
  if (!State.nodes.has(startNodeId)) return null;

  const scores = new Map();
  const queue  = [{ id: startNodeId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift();
    if (depth > CONFIG.BFS_MAX_DEPTH) continue;

    const contribution = Math.pow(CONFIG.DECAY_FACTOR, depth);
    scores.set(id, (scores.get(id) || 0) + contribution);

    const neighbors = State.edges.get(id) || new Set();
    for (const neighbor of neighbors) {
      queue.push({ id: neighbor, depth: depth + 1 });
    }
  }

  return Array.from(scores.entries())
    .map(([nodeId, score]) => ({
      node:     nodeId,
      metadata: State.nodes.get(nodeId) || {},
      score:    Math.round(score * 1000) / 1000
    }))
    .sort((a, b) => b.score - a.score);
}

function computeAllInfluence() {
  const result = {};
  for (const nodeId of State.nodes.keys()) {
    result[nodeId] = computeInfluence(nodeId)?.[0]?.score ?? 0;
  }
  return result;
}

// =====================================================
// RECOVERY
// =====================================================
function recoverState() {
  const snapshot = Storage.loadSnapshot();
  const events   = Storage.loadEventLog();
  let startIndex = 0;

  if (snapshot && typeof snapshot.lastEventIndex === 'number') {
    State.nodes.clear();
    State.edges.clear();
    (snapshot.nodes || []).forEach(n => State.nodes.set(n.id, n));
    (snapshot.edges || []).forEach(([k, v]) => {
      State.edges.set(k, new Set(v));
    });
    State.lastEventIndex = snapshot.lastEventIndex;
    startIndex           = snapshot.lastEventIndex + 1;
    console.log(`[RECOVERY] Snapshot loaded at index ${snapshot.lastEventIndex}`);
  }

  let replayed = 0;
  for (let i = startIndex; i < events.length; i++) {
    try {
      applyEvent(events[i]);
      State.lastEventIndex = i;
      replayed++;
    } catch (err) {
      console.error(`[RECOVERY] Skipping corrupt event at index ${i}:`, err.message);
    }
  }

  console.log(`[RECOVERY] Replayed ${replayed} events. Graph: ${State.nodes.size} nodes, ${State.edges.size} edges.`);
}

// =====================================================
// SNAPSHOT
// =====================================================
function createSnapshot() {
  const nodesArr = Array.from(State.nodes.values());
  const edgesArr = Array.from(State.edges.entries())
    .map(([k, v]) => [k, Array.from(v)]);

  Storage.saveSnapshot({
    nodes:          nodesArr,
    edges:          edgesArr,
    lastEventIndex: State.lastEventIndex,
    timestamp:      Date.now()
  });

  console.log(`[SNAPSHOT] Saved at index ${State.lastEventIndex}`);
}

// =====================================================
// EVENT QUEUE  (serialized to prevent index drift)
// =====================================================
const EventQueue = {
  _processing: false,
  _queue:      [],

  enqueue(event, callback) {
    this._queue.push({ event, callback });
    this._drain();
  },

  _drain() {
    if (this._processing || this._queue.length === 0) return;
    this._processing = true;
    const { event, callback } = this._queue.shift();
    try {
      Storage.appendEvent(event);
      applyEvent(event);
      State.lastEventIndex++;
      broadcast({ type: 'UPDATE', event, graphSize: State.nodes.size });
      callback({ success: true });
    } catch (err) {
      callback({ success: false, error: err.message });
    } finally {
      this._processing = false;
      this._drain();
    }
  }
};

// =====================================================
// WEBSOCKET
// =====================================================
const wss     = new WebSocket.Server({ noServer: true });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'INIT', graph: graphPayload() }));
  ws.on('close', () => clients.delete(ws));
  // FIX: error handler prevents unhandled exception crashing the process
  ws.on('error', (err) => {
    console.error('[WS] Client error:', err.message);
    clients.delete(ws);
  });
});

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

function graphPayload() {
  return {
    nodes: Array.from(State.nodes.values()),
    edges: Array.from(State.edges.entries()).map(([from, targets]) => ({
      from,
      to: Array.from(targets)
    })),
    lastEventIndex: State.lastEventIndex
  };
}

// =====================================================
// HTTP SERVER
// =====================================================
const server = http.createServer((req, res) => {
  const origin  = req.headers.origin || '';
  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    return res.end();
  }

  // --- Serve index.html ---
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const indexPath = path.join(__dirname, 'index.html');
    fs.readFile(indexPath, (err, data) => {
      if (err) {
        res.writeHead(404, headers);
        return res.end(JSON.stringify({ error: 'index.html not found' }));
      }
      res.writeHead(200, { ...corsHeaders(origin), 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // --- GET /health ---
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, headers);
    return res.end(JSON.stringify({
      status:         'ok',
      nodes:          State.nodes.size,
      edges:          State.edges.size,
      lastEventIndex: State.lastEventIndex,
      uptime:         Math.floor(process.uptime()),
      timestamp:      Date.now()
    }));
  }

  // --- GET /graph ---
  if (req.method === 'GET' && req.url === '/graph') {
    res.writeHead(200, headers);
    return res.end(JSON.stringify(graphPayload()));
  }

  // --- GET /influence (all nodes) ---
  if (req.method === 'GET' && req.url === '/influence') {
    res.writeHead(200, headers);
    return res.end(JSON.stringify({ scores: computeAllInfluence() }));
  }

  // --- GET /influence/:nodeId ---
  // FIX: Restored — dropped in v14.1, documented in README and used by frontend
  if (req.method === 'GET' && req.url.startsWith('/influence/')) {
    const nodeId = decodeURIComponent(req.url.slice('/influence/'.length));
    if (!nodeId) {
      res.writeHead(400, headers);
      return res.end(JSON.stringify({ error: 'Missing nodeId' }));
    }
    const result = computeInfluence(nodeId);
    if (result === null) {
      res.writeHead(404, headers);
      return res.end(JSON.stringify({ error: `Node '${nodeId}' not found` }));
    }
    res.writeHead(200, headers);
    return res.end(JSON.stringify({ nodeId, influence: result }));
  }

  // --- POST /event ---
  if (req.method === 'POST' && req.url === '/event') {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
      // FIX: Body size guard restored — was missing in v14.1
      if (body.length > CONFIG.MAX_EVENT_SIZE_BYTES) {
        req.destroy(new Error('Payload too large'));
      }
    });

    req.on('end', () => {
      const event = safeJsonParse(body);
      if (!validateEvent(event)) {
        res.writeHead(400, headers);
        return res.end(JSON.stringify({
          success: false,
          error:   'Invalid event. Required: { type: "NODE_ADDED"|"EDGE_ADDED", data: { id } | { from, to } }'
        }));
      }
      EventQueue.enqueue(event, (result) => {
        res.writeHead(result.success ? 200 : 500, headers);
        res.end(JSON.stringify(result));
      });
    });

    req.on('error', (err) => {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ success: false, error: err.message }));
    });

    return;
  }

  // --- 404 ---
  res.writeHead(404, headers);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// =====================================================
// STARTUP
// =====================================================
function start() {
  console.log('[PADI] Starting engine...');
  recoverState();

  setInterval(createSnapshot, CONFIG.SNAPSHOT_INTERVAL_MS);

  // FIX: SIGTERM added — Render sends SIGTERM for graceful shutdown,
  // not SIGINT. Without this, final snapshot never saves on redeploy.
  process.on('SIGINT',  () => { createSnapshot(); process.exit(0); });
  process.on('SIGTERM', () => { createSnapshot(); process.exit(0); });

  server.listen(CONFIG.PORT, () => {
    console.log(`[PADI] Engine live on port ${CONFIG.PORT}`);
    console.log('[PADI] Endpoints:');
    console.log('       GET  /');
    console.log('       GET  /health');
    console.log('       GET  /graph');
    console.log('       GET  /influence');
    console.log('       GET  /influence/:nodeId');
    console.log('       POST /event');
    console.log('       WS   ws://localhost:' + CONFIG.PORT);
  });
}

start();
