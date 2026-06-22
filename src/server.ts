/**
 * HTTP API exposing the engine — node:http only, no external deps.
 *
 * One Dispatcher drives planning; SSE fans dispatcher events out to browser
 * clients keyed by sessionId. Each /plan gets a unique channel so concurrent
 * sessions never block on the dispatcher's single-active-channel lock.
 *
 * Robustness: every request is wrapped — a malformed body or a throwing handler
 * becomes a 4xx/5xx, never a process crash.
 */
import { createServer as httpCreateServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { Dispatcher } from './dispatcher.js';
import { deepseekProvider } from './providers/deepseek.js';
import * as store from './store.js';

/** Per-process channel counter so concurrent /plan calls don't share a lock. */
let n = 0;

const MAX_BODY = 1024 * 1024; // 1MB cap on request bodies
const KEEPALIVE_MS = 15_000; // SSE keepalive comment interval

/** Dispatcher events to relay over SSE. Each payload carries a sessionId. */
const RELAY_EVENTS = [
  'ready',
  'phase',
  'progress',
  'gate',
  'approved',
  'failed',
  'killed',
] as const;

export function createServer(): Server {
  const dispatcher = new Dispatcher(deepseekProvider);

  // Reap any zombies left over from a previous crash on startup.
  const reaped = store.reapZombies();
  if (reaped > 0) {
    console.error(`[ultraplan] reaped ${reaped} zombie session(s) on startup`);
  }
  // Run the reaper periodically so sessions stranded while the server
  // is running are detected without waiting for a status poll.
  const reaperInterval = setInterval(() => {
    const n = store.reapZombies();
    if (n > 0) console.error(`[ultraplan] reaped ${n} zombie session(s)`);
  }, 60_000);
  // Stop the reaper when the server closes.
  const stopReaper = () => clearInterval(reaperInterval);

  // sessionId -> set of live SSE responses.
  const clients = new Map<string, Set<ServerResponse>>();

  function broadcast(event: string, payload: { sessionId?: string }): void {
    const id = payload?.sessionId;
    if (!id) return;
    const set = clients.get(id);
    if (!set || set.size === 0) return;
    const frame = `event: ${event}\ndata: ${safeJson(payload)}\n\n`;
    for (const res of set) {
      try {
        res.write(frame);
      } catch {
        // A dead socket; drop it on its 'close' handler. Ignore here.
      }
    }
  }

  // Subscribe once; relay every dispatcher event to its session's clients.
  for (const ev of RELAY_EVENTS) {
    dispatcher.on(ev, (payload: { sessionId?: string }) => broadcast(ev, payload));
  }

  const server = httpCreateServer((req, res) => {
    // Wrap the whole handler: one bad client must never take down the server.
    void handle(req, res, dispatcher, clients).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      sendJson(res, 500, { error: msg });
    });
  });

  // Clean up the periodic reaper when the server shuts down.
  server.on('close', stopReaper);

  return server;
}

export function startServer(port: number): Server {
  const server = createServer();
  server.listen(port, () => {
    console.log(`pi-ultraplan server listening on http://localhost:${port}`);
  });
  return server;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  dispatcher: Dispatcher,
  clients: Map<string, Set<ServerResponse>>,
): Promise<void> {
  // Permissive CORS for the local UI.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  // GET /health — health check for load balancers / monitoring.
  if (method === 'GET' && path === '/health') {
    sendJson(res, 200, { ok: true, uptime: process.uptime() });
    return;
  }

  // GET /sessions — list all sessions (with fresh zombie reaping).
  if (method === 'GET' && path === '/sessions') {
    const sessions = store.listSessions();
    // Return a compact summary: sessionId, status, prompt, startedAt.
    const summary = sessions.map((s) => ({
      sessionId: s.sessionId,
      status: s.status,
      prompt: s.prompt,
      model: s.model,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
      error: s.error,
      progress: s.progress,
    }));
    sendJson(res, 200, summary);
    return;
  }

  // Root: serve the minimal UI.
  if (method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  // POST /plan
  if (method === 'POST' && path === '/plan') {
    const body = await readJsonBody(req, res);
    if (body === undefined) return; // readJsonBody already responded
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      sendJson(res, 400, { error: 'prompt required' });
      return;
    }
    const repoRoot = typeof body.repoRoot === 'string' ? body.repoRoot : undefined;
    const model = typeof body.model === 'string' ? body.model : undefined;
    const channel = `web-${++n}`;
    const result = await dispatcher.dispatch({ prompt, repoRoot, model, channel });
    if ('error' in result) {
      sendJson(res, 409, { error: result.error });
      return;
    }
    sendJson(res, 200, { sessionId: result.sessionId });
    return;
  }

  // GET /session/:id
  const sessionMatch = matchPath(path, '/session/');
  if (method === 'GET' && sessionMatch) {
    const rec = store.read(sessionMatch);
    if (!rec) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }
    sendJson(res, 200, rec);
    return;
  }

  // GET /events/:id  (SSE)
  const eventsMatch = matchPath(path, '/events/');
  if (method === 'GET' && eventsMatch) {
    openSse(eventsMatch, req, res, clients);
    return;
  }

  // POST /approve/:id
  const approveMatch = matchPath(path, '/approve/');
  if (method === 'POST' && approveMatch) {
    await dispatcher.approve(approveMatch);
    sendJson(res, 200, { ok: true });
    return;
  }

  // POST /reject/:id
  const rejectMatch = matchPath(path, '/reject/');
  if (method === 'POST' && rejectMatch) {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const note = typeof body.note === 'string' ? body.note : undefined;
    await dispatcher.reject(rejectMatch, note);
    sendJson(res, 200, { ok: true });
    return;
  }

  // POST /execute/:id
  const executeMatch = matchPath(path, '/execute/');
  if (method === 'POST' && executeMatch) {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    if (!deepseekProvider.execute) {
      sendJson(res, 500, { error: 'execute not supported by provider' });
      return;
    }
    try {
      const openPullRequest =
        typeof body.openPullRequest === 'boolean' ? body.openPullRequest : undefined;
      const result = await deepseekProvider.execute(executeMatch, { openPullRequest });
      sendJson(res, 200, { result });
    } catch (e) {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }

  // POST /stop/:id
  const stopMatch = matchPath(path, '/stop/');
  if (method === 'POST' && stopMatch) {
    await dispatcher.stop(stopMatch);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

/** Open an SSE stream: snapshot the current record, register the client, and
 *  keep the connection alive until close. */
function openSse(
  sessionId: string,
  req: IncomingMessage,
  res: ServerResponse,
  clients: Map<string, Set<ServerResponse>>,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Immediate snapshot of the current persisted state (or null).
  const rec = store.read(sessionId) ?? null;
  res.write(`event: snapshot\ndata: ${safeJson(rec)}\n\n`);

  let set = clients.get(sessionId);
  if (!set) {
    set = new Set();
    clients.set(sessionId, set);
  }
  set.add(res);

  const keepalive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      // ignore write failures; close handler will clean up.
    }
  }, KEEPALIVE_MS);

  req.on('close', () => {
    clearInterval(keepalive);
    const s = clients.get(sessionId);
    if (s) {
      s.delete(res);
      if (s.size === 0) clients.delete(sessionId);
    }
  });
}

/** Extract the trailing segment of a path under a prefix, or null. Rejects
 *  empty / nested segments. */
function matchPath(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (!rest || rest.includes('/')) return null;
  return decodeURIComponent(rest);
}

/** Read + parse a JSON request body with a size cap. On malformed JSON or an
 *  oversized body it responds (400) and returns undefined; otherwise returns the
 *  parsed object. An empty body parses to {}. */
function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        aborted = true;
        sendJson(res, 400, { error: 'request body too large' });
        req.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          resolve(parsed as Record<string, unknown>);
        } else {
          sendJson(res, 400, { error: 'body must be a JSON object' });
          resolve(undefined);
        }
      } catch {
        sendJson(res, 400, { error: 'malformed JSON' });
        resolve(undefined);
      }
    });

    req.on('error', () => {
      if (aborted) return;
      aborted = true;
      sendJson(res, 400, { error: 'request error' });
      resolve(undefined);
    });
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  try {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(safeJson(payload));
  } catch {
    // Last-resort guard: never let a response failure bubble up.
  }
}

/** JSON.stringify that never throws (circular refs etc. degrade to a stub). */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '{"error":"unserializable"}';
  }
}

/** The minimal UI. All server/model text is injected via textContent — never
 *  innerHTML — so plan content can't inject script (XSS). */
const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>pi-ultraplan</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 900px; }
  textarea { width: 100%; height: 6rem; font-family: inherit; box-sizing: border-box; }
  button { margin: 0.25rem 0.25rem 0.25rem 0; padding: 0.4rem 0.8rem; cursor: pointer; }
  #log { background: #111; color: #0f0; padding: 0.75rem; height: 16rem;
         overflow-y: auto; white-space: pre-wrap; font-family: ui-monospace, monospace;
         font-size: 0.85rem; margin-top: 1rem; }
  #plan { border: 1px solid #ccc; padding: 0.75rem; margin-top: 1rem;
          white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 0.85rem; }
  .row { margin-top: 0.5rem; }
  h1 { font-size: 1.2rem; }
</style>
</head>
<body>
  <h1>pi-ultraplan</h1>
  <textarea id="prompt" placeholder="Describe what to plan..."></textarea>
  <div class="row">
    <button id="planBtn">Plan</button>
    <span id="sid"></span>
  </div>
  <div id="gate" style="display:none">
    <h2 style="font-size:1rem">Plan ready</h2>
    <div id="plan"></div>
    <div class="row">
      <button id="approveBtn">Approve</button>
      <button id="rejectBtn">Reject</button>
      <button id="executeBtn">Execute</button>
    </div>
  </div>
  <div id="log"></div>

<script>
(function () {
  var planBtn = document.getElementById('planBtn');
  var promptEl = document.getElementById('prompt');
  var sidEl = document.getElementById('sid');
  var logEl = document.getElementById('log');
  var gateEl = document.getElementById('gate');
  var planEl = document.getElementById('plan');
  var current = null;
  var es = null;

  function log(line) {
    var div = document.createElement('div');
    div.textContent = line; // textContent => no HTML injection
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json().catch(function () { return {}; }); });
  }

  function relay(name) {
    return function (e) {
      var data = e.data;
      try { data = JSON.stringify(JSON.parse(e.data)); } catch (_) {}
      log('[' + name + '] ' + data);
    };
  }

  function showGate(plan) {
    gateEl.style.display = 'block';
    planEl.textContent = (plan && plan.text) ? plan.text : '(no plan text)';
  }

  planBtn.addEventListener('click', function () {
    var prompt = promptEl.value.trim();
    if (!prompt) { log('prompt required'); return; }
    planBtn.disabled = true;
    gateEl.style.display = 'none';
    post('/plan', { prompt: prompt }).then(function (res) {
      planBtn.disabled = false;
      if (res.error) { log('error: ' + res.error); return; }
      current = res.sessionId;
      sidEl.textContent = 'session: ' + current;
      log('dispatched ' + current);
      if (es) es.close();
      es = new EventSource('/events/' + encodeURIComponent(current));
      ['ready','phase','progress','approved','failed','killed','snapshot']
        .forEach(function (name) { es.addEventListener(name, relay(name)); });
      es.addEventListener('snapshot', function (e) {
        try {
          var rec = JSON.parse(e.data);
          if (rec && rec.plan) showGate(rec.plan);
        } catch (_) {}
      });
      es.addEventListener('gate', function (e) {
        log('[gate] plan ready');
        try {
          var payload = JSON.parse(e.data);
          showGate(payload.plan);
        } catch (_) { showGate(null); }
      });
      es.onerror = function () { log('(event stream error)'); };
    }).catch(function (err) {
      planBtn.disabled = false;
      log('request failed: ' + (err && err.message ? err.message : err));
    });
  });

  document.getElementById('approveBtn').addEventListener('click', function () {
    if (!current) return;
    post('/approve/' + encodeURIComponent(current)).then(function (r) {
      log('approve: ' + JSON.stringify(r));
    });
  });
  document.getElementById('rejectBtn').addEventListener('click', function () {
    if (!current) return;
    var note = window.prompt('Reject note (optional):') || undefined;
    post('/reject/' + encodeURIComponent(current), { note: note }).then(function (r) {
      log('reject: ' + JSON.stringify(r));
    });
  });
  document.getElementById('executeBtn').addEventListener('click', function () {
    if (!current) return;
    log('executing...');
    post('/execute/' + encodeURIComponent(current), { openPullRequest: false })
      .then(function (r) { log('execute: ' + JSON.stringify(r)); });
  });
})();
</script>
</body>
</html>`;
