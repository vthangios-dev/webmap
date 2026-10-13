const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const dotenv = require("dotenv");

dotenv.config();

const PORT = Number(process.env.PORT || 3016);
const MAP_INGEST_TOKEN = process.env.MAP_INGEST_TOKEN || "";

const app = express();
app.use(express.json({ limit: "256kb" }));

app.use(express.static(path.join(__dirname, "public")));

const latestByMatch = new Map();
const socketsByMatch = new Map();

function nowMs() {
  return Date.now();
}

function sanitizeMatchId(raw) {
  const value = String(raw || "").trim();
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

function safeNumber(n, fallback = 0) {
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(n) {
  return Math.max(0, Math.min(1, safeNumber(n)));
}

function sanitizeEntity(entity) {
  return {
    id: String(entity.id || ""),
    name: String(entity.name || ""),
    type: String(entity.type || "hero"),
    team: safeNumber(entity.team, 0),
    x: clamp01(entity.x),
    y: clamp01(entity.y),
    dead: Boolean(entity.dead),
    visible: entity.visible === undefined ? true : Boolean(entity.visible),
    hp: Math.max(0, safeNumber(entity.hp, 0)),
    maxHp: Math.max(1, safeNumber(entity.maxHp, 1))
  };
}

function sanitizePayload(input) {
  const entities = Array.isArray(input.entities) ? input.entities : [];
  const selfTeam = safeNumber(input?.meta?.selfTeam, 0);
  return {
    ts: safeNumber(input.ts, nowMs()),
    meta: {
      selfTeam
    },
    entities: entities.map(sanitizeEntity)
  };
}

function getClientSet(matchId) {
  if (!socketsByMatch.has(matchId)) {
    socketsByMatch.set(matchId, new Set());
  }
  return socketsByMatch.get(matchId);
}

function broadcast(matchId, data) {
  const clients = getClientSet(matchId);
  const wire = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(wire);
    }
  }
}

function isAuthorized(req) {
  if (!MAP_INGEST_TOKEN) return true;
  const token = req.header("x-map-token") || "";
  return token === MAP_INGEST_TOKEN;
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    now: nowMs(),
    activeMatches: latestByMatch.size
  });
});

app.get("/webmap/:matchId", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/webmap", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/api/ingest/:matchId", (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const matchId = sanitizeMatchId(req.params.matchId);
  if (!matchId) {
    return res.status(400).json({ ok: false, error: "Invalid matchId" });
  }

  if (typeof req.body !== "object" || !req.body) {
    return res.status(400).json({ ok: false, error: "Invalid body" });
  }

  const payload = sanitizePayload(req.body);
  const snapshot = {
    type: "snapshot",
    matchId,
    updatedAt: nowMs(),
    payload
  };

  latestByMatch.set(matchId, snapshot);
  broadcast(matchId, snapshot);

  return res.json({ ok: true, matchId, count: payload.entities.length });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  let matchId = sanitizeMatchId(url.searchParams.get("match"));

  function joinMatch(nextMatchId) {
    if (!nextMatchId) return;

    if (ws.matchId) {
      const prev = getClientSet(ws.matchId);
      prev.delete(ws);
    }

    ws.matchId = nextMatchId;
    getClientSet(nextMatchId).add(ws);

    const latest = latestByMatch.get(nextMatchId);
    if (latest && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(latest));
    }
  }

  if (matchId) {
    joinMatch(matchId);
  }

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch (_err) {
      return;
    }

    if (message?.type === "subscribe") {
      const nextMatchId = sanitizeMatchId(message.matchId);
      if (nextMatchId) {
        joinMatch(nextMatchId);
      }
    }
  });

  ws.on("close", () => {
    if (ws.matchId) {
      getClientSet(ws.matchId).delete(ws);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Webmap server listening on :${PORT}`);
});
