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
async function callGemini(paper, entries, paperBase64 = null) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Falta la variable de entorno GEMINI_API_KEY');

  const history = entries.map(e => {
    const tag = e.overtime ? ' [TIEMPO EXCEDIDO]' : '';
    const label = e.team === 'azul' ? '🔵 Equipo Azul' : '🔴 Equipo Rojo';
    return `${label}${tag}: "${e.text}"`;
  }).join('\n');

  const evalInstructions = `Evaluá los argumentos de cada equipo en tres dimensiones (valores entre 0.0 y 1.0):
- score_paper: qué tan bien usaron y citaron el material de referencia
- score_retorica: calidad retórica, claridad y poder de persuasión
- score_contra: qué tan efectivamente rebatieron los argumentos del equipo contrario

Respondé ÚNICAMENTE con JSON válido con esta estructura exacta, sin texto adicional:
{"azul":{"score_paper":0.0,"score_retorica":0.0,"score_contra":0.0},"rojo":{"score_paper":0.0,"score_retorica":0.0,"score_contra":0.0}}`;

  let parts;
  if (paperBase64) {
    parts = [
      { inlineData: { mimeType: 'application/pdf', data: paperBase64 } },
      { text: `Sos un analista de debates parlamentarios. El documento adjunto es el material de referencia del debate. Evaluá la calidad de los argumentos de dos equipos debatiendo sobre dicho material.

HISTORIAL DEL DEBATE:
${history}

${evalInstructions}` },
    ];
  } else {
    parts = [{ text: `Sos un analista de debates parlamentarios. Evaluá la calidad de los argumentos de dos equipos debatiendo sobre el siguiente material de referencia.

MATERIAL DE REFERENCIA:
${paper}

HISTORIAL DEL DEBATE:
${history}

${evalInstructions}` }];
  }

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
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

// ─── Gemini: informe narrativo ────────────────────────────────────────────────
async function callGeminiReport(paper, entries, scores, finalCounts) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Falta GEMINI_API_KEY');

  const history = entries.map(e => {
    const label = e.team === 'azul' ? 'Equipo Azul' : 'Equipo Rojo';
    const ot    = e.overtime ? ' [TIEMPO EXCEDIDO]' : '';
    return `[Ronda ${e.round}] ${label}${ot}: "${e.text}"`;
  }).join('\n');

  const pct       = v => `${Math.round(v * 100)}%`;
  const roundNums = [...new Set(entries.map(e => e.round))].sort((a, b) => a - b);

  const prompt = `Sos un analista parlamentario. Evaluá el siguiente debate y elaborá un informe.

PUNTAJES FINALES:
- Equipo Azul: Paper ${pct(scores.azul.score_paper)} | Retórica ${pct(scores.azul.score_retorica)} | Contra-arg ${pct(scores.azul.score_contra)}
- Equipo Rojo: Paper ${pct(scores.rojo.score_paper)} | Retórica ${pct(scores.rojo.score_retorica)} | Contra-arg ${pct(scores.rojo.score_contra)}

RESULTADO EN EL SENADO: ${finalCounts.azul} a favor | ${finalCounts.amarillo} indecisos | ${finalCounts.rojo} en contra

HISTORIAL DEL DEBATE:
${history}

Respondé ÚNICAMENTE con JSON válido con esta estructura:
{
  "ganador": "azul",
  "explicacion": "2-3 oraciones explicando por qué ganó ese equipo basándote en los puntajes y los argumentos.",
  "argumento_fuerte": {
    "azul": { "texto": "cita textual exacta del argumento más impactante del equipo azul", "razon": "una oración sobre por qué fue el más efectivo" },
    "rojo": { "texto": "cita textual exacta del argumento más impactante del equipo rojo", "razon": "una oración sobre por qué fue el más efectivo" }
  },
  "rondas": [${roundNums.map(r => `{"numero":${r},"azul":0.0,"rojo":0.0}`).join(',')}]
}

Para "rondas": estimá el impacto acumulado de los argumentos al finalizar cada ronda (0.0–1.0).
Para "ganador": usá "azul", "rojo" o "empate".`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
    }
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini informe ${resp.status}: ${err.slice(0, 200)}`);
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
  // Agrupar por (tipo, estado) para aplicar P como fracción determinista
  const groups = new Map();
  for (const senator of state.senators) {
    const key = `${senatorType(senator.id)}|${senator.stance}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(senator);
  }

  const updated = new Map();
  for (const [key, senators] of groups) {
    const [type, stance] = key.split('|');
    const w  = WEIGHTS[type];
    const sa = w.paper * scores.azul.score_paper
             + w.retorica * scores.azul.score_retorica
             + w.contra   * scores.azul.score_contra;
    const sr = w.paper * scores.rojo.score_paper
             + w.retorica * scores.rojo.score_retorica
             + w.contra   * scores.rojo.score_contra;

    const delta = sa - sr;
    const k     = stance === 'amarillo' ? 3 : 1.2;
    const pAzul = 1 / (1 + Math.exp(-k * delta));

    // Exactamente round(pAzul * n) se mueven hacia azul, el resto hacia rojo
    const nAzul = Math.round(pAzul * senators.length);
    senators.forEach((senator, i) => {
      let newStance;
      if (i < nAzul) {
        newStance = stance === 'rojo' ? 'amarillo' : 'azul';
      } else {
        newStance = stance === 'azul' ? 'amarillo' : 'rojo';
      }
      updated.set(senator.id, { ...senator, stance: newStance });
    });
  }

  state.senators = state.senators.map(s => updated.get(s.id));
}

// ─── Corrección de consistencia ───────────────────────────────────────────────
// Senadores por tipo: 30 académicos (pos 0-9), 21 retóricos (10-16), 21 twitteros (17-23)
const TYPE_N = { academico: 30, retorico: 21, twittero: 21 };

function applyConsistencyCorrection(scores) {
  // Score ponderado total: promedio pesado por cantidad de senadores de cada tipo
  const saByType = {}, srByType = {};
  let totalAzul = 0, totalRojo = 0;
  for (const type of ['academico', 'retorico', 'twittero']) {
    const w = WEIGHTS[type];
    saByType[type] = w.paper * scores.azul.score_paper + w.retorica * scores.azul.score_retorica + w.contra * scores.azul.score_contra;
    srByType[type] = w.paper * scores.rojo.score_paper  + w.retorica * scores.rojo.score_retorica  + w.contra * scores.rojo.score_contra;
    totalAzul += TYPE_N[type] * saByType[type];
    totalRojo  += TYPE_N[type] * srByType[type];
  }
  if (Math.abs(totalAzul - totalRojo) < 1e-9) return;

  const winner = totalAzul > totalRojo ? 'azul' : 'rojo';
  const loser  = winner === 'azul' ? 'rojo' : 'azul';

  const stanceMap = new Map(state.senators.map(s => [s.id, s.stance]));
  const count = st => [...stanceMap.values()].filter(v => v === st).length;
  if (count(winner) >= count(loser)) return;

  const pAzulFor = (id, stance) => {
    const k = stance === 'amarillo' ? 3 : 1.2;
    const t = senatorType(id);
    return 1 / (1 + Math.exp(-k * (saByType[t] - srByType[t])));
  };
  const deltaFor = id => { const t = senatorType(id); return saByType[t] - srByType[t]; };

  // Paso 1: amarillos con mayor probabilidad logit de ser del equipo ganador
  const amarillos = state.senators
    .filter(s => stanceMap.get(s.id) === 'amarillo')
    .map(s => ({ id: s.id, pW: winner === 'azul' ? pAzulFor(s.id, 'amarillo') : 1 - pAzulFor(s.id, 'amarillo') }))
    .sort((a, b) => b.pW - a.pW);

  for (const { id } of amarillos) {
    if (count(winner) >= count(loser)) break;
    stanceMap.set(id, winner);
  }

  // Paso 2: solo si los amarillos no alcanzaron — senadores del perdedor con |Δ| más cercano a 0
  if (count(winner) < count(loser)) {
    const loserSens = state.senators
      .filter(s => stanceMap.get(s.id) === loser)
      .map(s => ({ id: s.id, absD: Math.abs(deltaFor(s.id)) }))
      .sort((a, b) => a.absD - b.absD);

    for (const { id } of loserSens) {
      if (count(winner) >= count(loser)) break;
      stanceMap.set(id, winner);
    }
  }

  state.senators = state.senators.map(s => ({ ...s, stance: stanceMap.get(s.id) }));
  console.log(`[voting] corrección consistencia — ganador por score ponderado: ${winner} (${totalAzul.toFixed(2)} vs ${totalRojo.toFixed(2)})`);
}

// ─── Estado del debate ────────────────────────────────────────────────────────
const initTeam = Math.random() < 0.5 ? 'rojo' : 'azul';
const state = {
  paper:          '',
  paperBase64:    null,
  paperName:      '',
  entries:        [],   // { team, text, round, overtime, ts }
  round:          1,
  team:           initTeam,
  firstTeam:      initTeam,  // equipo que siempre arranca cada ronda
  roundFirstTeam: initTeam,
  senators:       buildInitialSenators(),
  lastScores:     null,
  mode:           'final',
  calculating:    false,
  pendingVote:    false,   // ronda completada mientras se calculaba la anterior
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
    paperSet:       !!(state.paper || state.paperBase64),
    paperName:      state.paperName,
    senators:       state.senators,
    mode:           state.mode,
  };
}

function advanceTurn(team) {
  if (team === state.roundFirstTeam) {
    state.team = team === 'rojo' ? 'azul' : 'rojo';
  } else {
    state.round++;
    state.team           = state.firstTeam;
    state.roundFirstTeam = state.firstTeam;
  }
}

// ─── Votación: función compartida ────────────────────────────────────────────
function sendToControls(type, data) {
  for (const [c, info] of clients.entries())
    if (info.type === 'control') send(c, type, data);
}

function triggerVoting(ws) {
  if (state.calculating) {
    send(ws, 'vote_error', { msg: 'Ya hay una votación en curso.' });
    return;
  }
  state.calculating = true;
  sendToControls('vote_loading', {});
  console.log('[gemini] llamando API…');

  callGemini(state.paper, state.entries, state.paperBase64)
    .then(scores => {
      const overtimeTeams = new Set(state.entries.filter(e => e.overtime).map(e => e.team));
      for (const team of overtimeTeams) {
        scores[team].score_retorica = Math.max(0, scores[team].score_retorica - 0.1);
        console.log(`[gemini] penalización overtime → ${team}`);
      }

      const before = new Map(state.senators.map(s => [s.id, s.stance]));
      runVoting(scores);
      applyConsistencyCorrection(scores);
      const changes = state.senators
        .filter(s => s.stance !== before.get(s.id))
        .map(s => ({ id: s.id, from: before.get(s.id), to: s.stance }));

      state.lastScores  = scores;
      state.calculating = false;
      broadcast('vote_animation', { changes, final: state.senators, mode: state.mode });
      sendToControls('vote_result', { scores });
      console.log(`[gemini] ${changes.length} senadores cambiaron | scores:`, JSON.stringify(scores));

      if (state.pendingVote && state.mode === 'por_ronda' && (state.paper || state.paperBase64)) {
        state.pendingVote = false;
        console.log('[gemini] ejecutando votación pendiente de ronda anterior');
        triggerVoting(ws);
      }
    })
    .catch(err => {
      state.calculating = false;
      console.error('[gemini] error:', err.message);
      sendToControls('vote_error', { msg: err.message });

      if (state.pendingVote && state.mode === 'por_ronda' && (state.paper || state.paperBase64)) {
        state.pendingVote = false;
        triggerVoting(ws);
      }
    });
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
        state.paper       = (data.text || '').trim();
        state.paperBase64 = null;
        state.paperName   = '';
        send(ws, 'paper_ack', { chars: state.paper.length });
        console.log(`[ws] paper guardado: ${state.paper.length} chars`);
        break;

      case 'set_mode':
        state.mode = data.mode === 'por_ronda' ? 'por_ronda' : 'final';
        console.log(`[ws] modo: ${state.mode}`);
        break;

      case 'add_argument': {
        const text = (data.text || '').trim();
        if (!text) break;
        const team  = data.team || state.team;
        const entry = { team, text, overtime: !!data.overtime, round: state.round, ts: Date.now() };
        state.entries.push(entry);
        const prevRound = state.round;
        advanceTurn(team);
        broadcast('state_update', snapshot());
        console.log(`[ws] argumento — ${team}, ronda ${entry.round}`);
        if (state.mode === 'por_ronda' && state.round > prevRound) {
          if (!state.paper && !state.paperBase64) {
            sendToControls('vote_error', { msg: 'Ronda completada pero no hay paper/PDF cargado. Cargá el contexto antes de empezar.' });
            console.log(`[ws] ronda ${prevRound} completa — sin paper, no se calcula`);
          } else if (state.calculating) {
            state.pendingVote = true;
            console.log(`[ws] ronda ${prevRound} completa (en cola — Gemini ocupado)`);
          } else {
            console.log(`[ws] ronda ${prevRound} completa — votación automática`);
            triggerVoting(ws);
          }
        }
        break;
      }

      case 'transcript_update':
        for (const [ws2, info] of clients.entries())
          if (info.type === 'control') send(ws2, 'transcript_update', data);
        break;

      case 'recording_status':
        broadcast('recording_status', data, ws);
        break;

      case 'generate_report': {
        if (!state.lastScores) {
          send(ws, 'report_error', { msg: 'No hay votación calculada todavía.' });
          break;
        }
        const finalCounts = { azul: 0, amarillo: 0, rojo: 0 };
        state.senators.forEach(s => { finalCounts[s.stance]++; });

        send(ws, 'report_loading', {});
        console.log('[gemini] generando informe…');

        callGeminiReport(state.paper, state.entries, state.lastScores, finalCounts)
          .then(analysis => {
            send(ws, 'report_data', {
              analysis,
              scores:      state.lastScores,
              finalCounts,
              entries:     state.entries,
            });
            console.log('[gemini] informe generado');
          })
          .catch(err => {
            console.error('[gemini] error en informe:', err.message);
            send(ws, 'report_error', { msg: err.message });
          });
        break;
      }

      case 'reset_session': {
        const newTeam = Math.random() < 0.5 ? 'rojo' : 'azul';
        state.entries        = [];
        state.round          = 1;
        state.team           = newTeam;
        state.firstTeam      = newTeam;
        state.roundFirstTeam = newTeam;
        state.senators       = buildInitialSenators();
        state.calculating    = false;
        state.paper          = '';
        state.paperBase64    = null;
        state.paperName      = '';
        state.pendingVote    = false;
        broadcast('state_update', snapshot());
        console.log('[ws] sesión reiniciada');
        break;
      }

      case 'calculate_votes': {
        if (!state.paper && !state.paperBase64) {
          send(ws, 'vote_error', { msg: 'No hay paper/blog cargado.' });
          break;
        }
        if (!state.entries.length) {
          send(ws, 'vote_error', { msg: 'No hay argumentos en el debate todavía.' });
          break;
        }
        triggerVoting(ws);
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
const noCache = (_, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

app.post('/upload-paper',
  express.raw({ type: 'application/pdf', limit: '20mb' }),
  (req, res) => {
    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: 'No se recibió ningún PDF' });
    }
    state.paper       = '';
    state.paperBase64 = req.body.toString('base64');
    state.paperName   = req.headers['x-filename'] || 'documento.pdf';
    const kb = Math.round(req.body.length / 1024);
    console.log(`[paper] PDF cargado: ${state.paperName}, ${kb} KB`);
    res.json({ ok: true, kb, name: state.paperName });
  }
);

app.get('/control', noCache, (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'control.html')));
app.get('/senado',  noCache, (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'senado.html')));
app.get('/tablet',  noCache, (_, res) =>
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
