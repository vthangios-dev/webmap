const path = require("path");
const http = require("http");
const fs = require("fs");
const express = require("express");
const { WebSocketServer } = require("ws");
const dotenv = require("dotenv");

dotenv.config();

const PORT = Number(process.env.PORT || 3016);
const ASSET_VERSION =
  String(process.env.ASSET_VERSION || Date.now()).replace(/[^a-zA-Z0-9_-]/g, "");
const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_TEMPLATE_PATH = path.join(PUBLIC_DIR, "index.html");
const INDEX_TEMPLATE = fs.readFileSync(INDEX_TEMPLATE_PATH, "utf8");

const app = express();
app.use(express.json({ limit: "3mb" }));

app.use(express.static(PUBLIC_DIR));

const latestByMatch = new Map();
const socketsByMatch = new Map();
const sequenceByMatch = new Map();

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
  const rawFrame = input?.mapFrame;
  let mapFrame = null;
  if (rawFrame && typeof rawFrame === "object") {
    const mime = String(rawFrame.mime || "image/jpeg").toLowerCase();
    const data = String(rawFrame.data || "");
    const width = Math.max(1, Math.min(1024, safeNumber(rawFrame.w, 0)));
    const height = Math.max(1, Math.min(1024, safeNumber(rawFrame.h, 0)));
    if (
      (mime === "image/jpeg" || mime === "image/png" || mime === "image/webp") &&
      data.length > 100 &&
      data.length <= 2_500_000 &&
      /^[A-Za-z0-9+/=]+$/.test(data)
    ) {
      mapFrame = {
        mime,
        data,
        w: width,
        h: height,
        ts: safeNumber(rawFrame.ts, nowMs())
      };
    }
  }
  return {
    ts: safeNumber(input.ts, nowMs()),
    meta: {
      selfTeam
    },
    entities: entities.map(sanitizeEntity),
    mapFrame
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
      if (ws.bufferedAmount > 1_000_000) {
        continue;
      }
      ws.send(wire);
    }
  }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    now: nowMs(),
    activeMatches: latestByMatch.size,
    assetVersion: ASSET_VERSION
  });
});

function renderIndex(res) {
  const html = INDEX_TEMPLATE.replace(/__ASSET_VERSION__/g, ASSET_VERSION);
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  res.type("html").send(html);
}

app.get("/style.:version.css", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.sendFile(path.join(PUBLIC_DIR, "style.css"));
});

app.get("/app.:version.js", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.sendFile(path.join(PUBLIC_DIR, "app.js"));
});

app.get("/webmap/:matchId", (_req, res) => {
  renderIndex(res);
});

app.get("/webmap", (_req, res) => {
  renderIndex(res);
});

app.post("/api/ingest/:matchId", (req, res) => {
  const matchId = sanitizeMatchId(req.params.matchId);
  if (!matchId) {
    return res.status(400).json({ ok: false, error: "Invalid matchId" });
  }

  if (typeof req.body !== "object" || !req.body) {
    return res.status(400).json({ ok: false, error: "Invalid body" });
  }

  const payload = sanitizePayload(req.body);
  const nextSeq = (sequenceByMatch.get(matchId) || 0) + 1;
  sequenceByMatch.set(matchId, nextSeq);
  const snapshot = {
    type: "snapshot",
    matchId,
    seq: nextSeq,
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
  console.log(`Asset version: ${ASSET_VERSION}`);
  console.log("Ingest auth: OFF (no token required)");
});
