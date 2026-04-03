'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CONFIG = {
  PORT: process.env.PORT || 8080,
  EVENT_LOG_PATH: path.join(__dirname, 'event_log.ndjson'),
  SNAPSHOT_PATH: path.join(__dirname, 'snapshot.json'),
  SNAPSHOT_INTERVAL_MS: 15000
};

const State = { nodes: new Map(), edges: new Map(), lastEventIndex: -1 };

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

// SEMANTIC BRIDGES: Connects the categories to the central Knowledge Protocol
function seedBridges() {
  const bridges = [
    { from: 'padi-01', to: 'h-01' }, // Meta to Computing
    { from: 'padi-01', to: 'h-02' }, // Meta to Mathematics
    { from: 'padi-01', to: 'm-03' }  // Meta to Justice
  ];
  bridges.forEach(applyEvent.bind(null, { type: 'EDGE_ADDED', data: {} })); // Simplified for seeding
  bridges.forEach(b => { if(State.edges.has(b.from)) State.edges.get(b.from).add(b.to); });
}

const server = http.createServer((req, res) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  // ROUTE: Serve the Visual Interface
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); return res.end("index.html not found"); }
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // ROUTE: API Graph Data
  if (req.method === 'GET' && req.url === '/graph') {
    res.writeHead(200, headers);
    return res.end(JSON.stringify({
      nodes: Array.from(State.nodes.values()),
      edges: Array.from(State.edges.entries()).map(([from, to]) => ({ from, to: Array.from(to) }))
    }));
  }

  res.writeHead(404, headers);
  res.end(JSON.stringify({ error: 'Not found' }));
});

function start() {
  // Load local archive or log
  if (fs.existsSync(CONFIG.EVENT_LOG_PATH)) {
    const lines = fs.readFileSync(CONFIG.EVENT_LOG_PATH, 'utf-8').split('\n');
    lines.forEach(l => { if(l) applyEvent(JSON.parse(l)); });
  }
  seedBridges(); // Ensure graph structural integrity
  server.listen(CONFIG.PORT, () => console.log(`[PADI] Final Engine live on ${CONFIG.PORT}`));
}
start();
