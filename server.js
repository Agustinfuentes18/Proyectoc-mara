const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');
const fs      = require('fs');

// Carga .env si existe (nunca hacer commit de ese archivo)
try {
  fs.readFileSync('.env', 'utf8').split('\n').forEach(line => {
    const [k, ...rest] = line.split('=');
    if (k && rest.length) process.env[k.trim()] = rest.join('=').trim();
  });
} catch { /* sin .env, se usan las vars del sistema */ }

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ─── Distribución inicial de senadores (azul izq, amarillo centro, rojo der) ─
function buildInitialSenators() {
  const rows = [{ count: 10 }, { count: 15 }, { count: 21 }, { count: 26 }];
  const positions = [];
  let id = 0;
  for (const row of rows) {
    for (let i = 0; i < row.count; i++) {
      const pct = row.count === 1 ? 0.5 : i / (row.count - 1);
      positions.push({ id: id++, pct });
    }
  }
  const sorted = [...positions].sort((a, b) => a.pct - b.pct);
  const stanceMap = new Map(sorted.map((p, i) => [
    p.id, i < 24 ? 'azul' : i < 48 ? 'amarillo' : 'rojo',
  ]));
  return Array.from({ length: 72 }, (_, i) => ({ id: i, stance: stanceMap.get(i) }));
}

// ─── Gemini API ───────────────────────────────────────────────────────────────
async function callGemini(paper, entries) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Falta la variable de entorno GEMINI_API_KEY');

  const history = entries.map(e => {
    const tag = e.overtime ? ' [TIEMPO EXCEDIDO]' : '';
    const label = e.team === 'azul' ? '🔵 Equipo Azul' : '🔴 Equipo Rojo';
    return `${label}${tag}: "${e.text}"`;
  }).join('\n');

  const prompt = `Sos un analista de debates parlamentarios. Evaluá la calidad de los argumentos de dos equipos debatiendo sobre el siguiente material de referencia.

MATERIAL DE REFERENCIA:
${paper}

HISTORIAL DEL DEBATE:
${history}

Evaluá los argumentos de cada equipo en tres dimensiones (valores entre 0.0 y 1.0):
- score_paper: qué tan bien usaron y citaron el material de referencia
- score_retorica: calidad retórica, claridad y poder de persuasión
- score_contra: qué tan efectivamente rebatieron los argumentos del equipo contrario

Respondé ÚNICAMENTE con JSON válido con esta estructura exacta, sin texto adicional:
{"azul":{"score_paper":0.0,"score_retorica":0.0,"score_contra":0.0},"rojo":{"score_paper":0.0,"score_retorica":0.0,"score_contra":0.0}}`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    }
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini ${resp.status}: ${err.slice(0, 200)}`);
  }

  const result = await resp.json();
  const text   = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Respuesta vacía de Gemini');
  return JSON.parse(text);
}

// ─── Modelo de votación ───────────────────────────────────────────────────────
const WEIGHTS = {
  academico: { paper: 0.60, retorica: 0.25, contra: 0.15 },
  retorico:  { paper: 0.20, retorica: 0.60, contra: 0.20 },
  twittero:  { paper: 0.15, retorica: 0.20, contra: 0.65 },
};

function senatorType(id) {
  const pos = id % 24;
  if (pos < 10) return 'academico';
  if (pos < 17) return 'retorico';
  return 'twittero';
}

function runVoting(scores) {
  state.senators = state.senators.map(senator => {
    const w  = WEIGHTS[senatorType(senator.id)];
    const sa = w.paper * scores.azul.score_paper
             + w.retorica * scores.azul.score_retorica
             + w.contra   * scores.azul.score_contra;
    const sr = w.paper * scores.rojo.score_paper
             + w.retorica * scores.rojo.score_retorica
             + w.contra   * scores.rojo.score_contra;

    const delta = sa - sr;
    const k     = senator.stance === 'amarillo' ? 3 : 1.2;
    const pAzul = 1 / (1 + Math.exp(-k * delta));

    let newStance;
    if (Math.random() < pAzul) {
      newStance = senator.stance === 'rojo' ? 'amarillo' : 'azul';
    } else {
      newStance = senator.stance === 'azul' ? 'amarillo' : 'rojo';
    }
    return { ...senator, stance: newStance };
  });
}

// ─── Estado del debate ────────────────────────────────────────────────────────
const initTeam = Math.random() < 0.5 ? 'rojo' : 'azul';
const state = {
  paper:          '',
  entries:        [],   // { team, text, round, overtime, ts }
  round:          1,
  team:           initTeam,
  roundFirstTeam: initTeam,
  senators:       buildInitialSenators(),
};

// ─── Helpers WebSocket ────────────────────────────────────────────────────────
const clients = new Map();

function send(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type, data }));
}

function broadcast(type, data, exclude = null) {
  for (const ws of clients.keys())
    if (ws !== exclude) send(ws, type, data);
}

function snapshot() {
  return {
    entries:        state.entries,
    round:          state.round,
    team:           state.team,
    roundFirstTeam: state.roundFirstTeam,
    paperSet:       !!state.paper,
    senators:       state.senators,
  };
}

function advanceTurn(team) {
  if (team === state.roundFirstTeam) {
    state.team = team === 'rojo' ? 'azul' : 'rojo';
  } else {
    const first = Math.random() < 0.5 ? 'rojo' : 'azul';
    state.round++;
    state.team           = first;
    state.roundFirstTeam = first;
  }
}

// ─── Servidor WebSocket ───────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.set(ws, { type: 'unknown' });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { type, data = {} } = msg;

    switch (type) {

      case 'identify':
        clients.set(ws, { type: data.clientType });
        send(ws, 'state_sync', snapshot());
        console.log(`[ws] cliente identificado: ${data.clientType}`);
        break;

      case 'test_event':
        broadcast('test_received', { ts: new Date().toISOString() });
        break;

      case 'set_paper':
        state.paper = (data.text || '').trim();
        send(ws, 'paper_ack', { chars: state.paper.length });
        console.log(`[ws] paper guardado: ${state.paper.length} chars`);
        break;

      case 'add_argument': {
        const text = (data.text || '').trim();
        if (!text) break;
        const team  = data.team || state.team;
        const entry = { team, text, overtime: !!data.overtime, round: state.round, ts: Date.now() };
        state.entries.push(entry);
        advanceTurn(team);
        broadcast('state_update', snapshot());
        console.log(`[ws] argumento — ${team}, ronda ${entry.round}`);
        break;
      }

      case 'transcript_update':
        for (const [ws2, info] of clients.entries())
          if (info.type === 'control') send(ws2, 'transcript_update', data);
        break;

      case 'recording_status':
        broadcast('recording_status', data, ws);
        break;

      case 'calculate_votes': {
        if (!state.paper) {
          send(ws, 'vote_error', { msg: 'No hay paper/blog cargado.' });
          break;
        }
        if (!state.entries.length) {
          send(ws, 'vote_error', { msg: 'No hay argumentos en el debate todavía.' });
          break;
        }

        send(ws, 'vote_loading', {});
        console.log('[gemini] llamando API…');

        callGemini(state.paper, state.entries)
          .then(scores => {
            // Penalización por overtime: -0.1 en retórica
            const overtimeTeams = new Set(
              state.entries.filter(e => e.overtime).map(e => e.team)
            );
            for (const team of overtimeTeams) {
              scores[team].score_retorica = Math.max(0, scores[team].score_retorica - 0.1);
              console.log(`[gemini] penalización overtime → ${team}`);
            }

            const before = new Map(state.senators.map(s => [s.id, s.stance]));
            runVoting(scores);
            const changes = state.senators
              .filter(s => s.stance !== before.get(s.id))
              .map(s => ({ id: s.id, from: before.get(s.id), to: s.stance }));

            broadcast('vote_animation', { changes, final: state.senators });
            send(ws, 'vote_result', { scores });
            console.log(`[gemini] ${changes.length} senadores cambiaron | scores:`, JSON.stringify(scores));
          })
          .catch(err => {
            console.error('[gemini] error:', err.message);
            send(ws, 'vote_error', { msg: err.message });
          });
        break;
      }
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    console.log(`[ws] desconectado: ${info?.type}`);
    clients.delete(ws);
  });
});

// ─── Rutas HTTP ───────────────────────────────────────────────────────────────
app.get('/control', (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'control.html')));
app.get('/senado',  (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'senado.html')));
app.get('/tablet',  (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'tablet.html')));

app.get('/', (_, res) => res.redirect('/control'));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🏛️  El Senado corriendo en http://localhost:${PORT}`);
  console.log(`   /control → panel privado`);
  console.log(`   /senado  → proyección`);
  console.log(`   /tablet  → tablet\n`);
});
