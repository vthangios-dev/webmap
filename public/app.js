const qs = new URLSearchParams(window.location.search);
const fromPath = window.location.pathname.match(/\/webmap\/([^/]+)/);
const defaultMatch = (fromPath?.[1] || "").trim();

const joinForm = document.getElementById("joinForm");
const mapCodeInput = document.getElementById("mapCodeInput");
const joinMapBtn = document.getElementById("joinMapBtn");
const resetBtn = document.getElementById("resetBtn");
const compactBtn = document.getElementById("compactBtn");
const popupBtn = document.getElementById("popupBtn");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const perspective = document.getElementById("perspective");

const wsDot = document.getElementById("wsDot");
const wsStatus = document.getElementById("wsStatus");
const roomValue = document.getElementById("roomValue");
const updatedAt = document.getElementById("updatedAt");
const countInfo = document.getElementById("countInfo");
const shareUrl = document.getElementById("shareUrl");
const copyLinkBtn = document.getElementById("copyLinkBtn");
const emptyOverlay = document.getElementById("emptyOverlay");

const floatingPanel = document.getElementById("floatingPanel");
const floatingHeader = document.getElementById("floatingHeader");
const floatingBody = document.getElementById("floatingBody");
const floatMatch = document.getElementById("floatMatch");
const floatStatus = document.getElementById("floatStatus");
const floatCount = document.getElementById("floatCount");
const toggleFloatingBtn = document.getElementById("toggleFloatingBtn");

const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");

const MAP_IMAGE_URL =
  qs.get("mapImg") ||
  "/assets/icons/terrain.png";

const mapImage = new Image();
mapImage.crossOrigin = "anonymous";
let mapImageLoaded = false;
mapImage.onload = () => {
  mapImageLoaded = true;
  render();
};
mapImage.onerror = () => {
  mapImageLoaded = false;
  render();
};
mapImage.src = MAP_IMAGE_URL;

let ws = null;
let snapshot = null;
let currentMatchId = "";
let shareLink = "";
let wsStatusText = "Chưa kết nối";
let reconnectTimer = null;

function sanitizeCode(code) {
  return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

function setWsState(isOnline, text) {
  wsStatusText = text;
  wsDot.className = `dot ${isOnline ? "on" : "off"}`;
  wsStatus.textContent = text;
  floatStatus.textContent = `WS: ${text}`;
  perspective.textContent = isOnline ? "Đang nhận dữ liệu trực tiếp" : "Chờ luồng từ iPhone";
}

function updateShare(matchId) {
  shareLink = `${window.location.origin}/webmap/${encodeURIComponent(matchId)}`;
  shareUrl.textContent = shareLink;
  roomValue.textContent = matchId || "—";
  floatMatch.textContent = `Mã map: ${matchId || "-"}`;
}

function resetSnapshotUI() {
  snapshot = null;
  updatedAt.textContent = "Chưa có dữ liệu";
  countInfo.textContent = "0";
  floatCount.textContent = "Đối tượng: 0";
  render();
}

function toCanvas(x01, y01) {
  return {
    x: x01 * canvas.width,
    y: (1 - y01) * canvas.height
  };
}

function drawBackground() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (mapImageLoaded) {
    ctx.drawImage(mapImage, 0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(6,12,20,0.38)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }

  ctx.fillStyle = "#0f1a30";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  for (let x = 0; x <= canvas.width; x += 60) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y <= canvas.height; y += 60) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
}

function drawEntity(entity, selfTeam) {
  const p = toCanvas(entity.x, entity.y);
  const isAlly = selfTeam && entity.team === selfTeam;
  const isEnemy = selfTeam && entity.team !== selfTeam;
  const color = isAlly ? "#4ab4ff" : (isEnemy ? "#ff6a92" : "#f2c76f");

  ctx.globalAlpha = entity.dead ? 0.35 : 1;
  ctx.beginPath();
  ctx.fillStyle = color;
  ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.strokeStyle = "rgba(255,255,255,0.88)";
  ctx.lineWidth = 2;
  ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
  ctx.stroke();

  const hpRate = Math.max(0, Math.min(1, entity.hp / Math.max(1, entity.maxHp)));
  const barW = 30;
  const barX = p.x - barW / 2;
  const barY = p.y - 20;
  ctx.fillStyle = "rgba(20,20,30,0.85)";
  ctx.fillRect(barX, barY, barW, 4);
  ctx.fillStyle = hpRate > 0.45 ? "#4be28e" : hpRate > 0.2 ? "#ffd35c" : "#ff6262";
  ctx.fillRect(barX, barY, barW * hpRate, 4);

  if (entity.name) {
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#eef3ff";
    ctx.fillText(entity.name, p.x - 11, p.y + 24);
  }
  ctx.globalAlpha = 1;
}

function render() {
  drawBackground();
  if (!snapshot?.payload?.entities?.length) {
    emptyOverlay.style.display = "block";
    return;
  }

  emptyOverlay.style.display = "none";
  const selfTeam = snapshot.payload.meta?.selfTeam || 0;
  for (const entity of snapshot.payload.entities) {
    drawEntity(entity, selfTeam);
  }
}

function handleSnapshot(msg) {
  snapshot = msg;
  updatedAt.textContent = new Date(msg.updatedAt).toLocaleTimeString();
  countInfo.textContent = String(msg.payload.entities.length);
  floatCount.textContent = `Đối tượng: ${msg.payload.entities.length}`;
  render();
}

function connect(matchId) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (ws) {
    ws.onclose = null;
    ws.close();
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/ws?match=${encodeURIComponent(matchId)}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    setWsState(true, "Đã kết nối");
    ws.send(JSON.stringify({ type: "subscribe", matchId }));
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "snapshot" && msg.matchId === matchId) {
        handleSnapshot(msg);
      }
    } catch (_err) {}
  };

  ws.onclose = () => {
    setWsState(false, "Mất kết nối, đang thử lại...");
    reconnectTimer = setTimeout(() => connect(matchId), 1300);
  };

  ws.onerror = () => ws.close();
}

function startMatch(code) {
  const matchId = sanitizeCode(code);
  if (matchId.length !== 6) {
    setWsState(false, "Mã phòng phải đủ 6 ký tự");
    return;
  }

  currentMatchId = matchId;
  mapCodeInput.value = matchId;
  updateShare(matchId);
  resetSnapshotUI();

  const nextUrl = `/webmap/${encodeURIComponent(matchId)}`;
  if (window.location.pathname !== nextUrl) {
    window.history.replaceState({}, "", nextUrl);
  }
  connect(matchId);
}

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  startMatch(mapCodeInput.value);
});

mapCodeInput.addEventListener("input", () => {
  mapCodeInput.value = sanitizeCode(mapCodeInput.value);
});

resetBtn.addEventListener("click", () => {
  currentMatchId = "";
  mapCodeInput.value = "";
  updateShare("");
  resetSnapshotUI();
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  setWsState(false, "Chưa kết nối");
  window.history.replaceState({}, "", "/webmap");
});

copyLinkBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(shareLink || window.location.href);
    copyLinkBtn.textContent = "Đã copy";
    setTimeout(() => {
      copyLinkBtn.textContent = "Copy Link";
    }, 900);
  } catch (_err) {
    copyLinkBtn.textContent = "Copy lỗi";
  }
});

compactBtn.addEventListener("click", () => {
  document.body.classList.toggle("compact");
});

popupBtn.addEventListener("click", () => {
  const target = shareLink || `${window.location.origin}/webmap`;
  window.open(target, "webmap-popup", "width=520,height=720,resizable=yes");
});

fullscreenBtn.addEventListener("click", () => {
  const elem = document.documentElement;
  if (!document.fullscreenElement) {
    elem.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
});

toggleFloatingBtn.addEventListener("click", () => {
  const collapsed = floatingBody.style.display === "none";
  floatingBody.style.display = collapsed ? "block" : "none";
  toggleFloatingBtn.textContent = collapsed ? "Thu gọn" : "Mở";
});

let dragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

floatingHeader.addEventListener("pointerdown", (e) => {
  if (e.target === toggleFloatingBtn) return;
  dragging = true;
  const rect = floatingPanel.getBoundingClientRect();
  dragOffsetX = e.clientX - rect.left;
  dragOffsetY = e.clientY - rect.top;
  floatingHeader.setPointerCapture(e.pointerId);
});

floatingHeader.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const x = Math.max(0, e.clientX - dragOffsetX);
  const y = Math.max(0, e.clientY - dragOffsetY);
  floatingPanel.style.left = `${x}px`;
  floatingPanel.style.top = `${y}px`;
  floatingPanel.style.right = "auto";
  floatingPanel.style.bottom = "auto";
});

floatingHeader.addEventListener("pointerup", (e) => {
  dragging = false;
  floatingHeader.releasePointerCapture(e.pointerId);
});

updateShare("");
resetSnapshotUI();

if (sanitizeCode(defaultMatch).length === 6) {
  startMatch(defaultMatch);
} else {
  setWsState(false, "Nhập mã phòng 6 ký tự để xem");
}
