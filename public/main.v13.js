(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const canvas = $("map");
  const ctx = canvas.getContext("2d");
  const LOGICAL_MAP_SIZE = 900;

  const android = /Android/i.test(navigator.userAgent);
  const mobile =
    android ||
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  const socketState = {
    ws: null,
    retry: 0,
    room: "",
    lastReceived: 0,
    lastSeq: 0,
    frame: null,
    mapFrameKey: "",
    mapFrameImage: null,
    pendingMapFrame: null
  };

  let video = null;
  let pipTimer = 0;
  let pipBusy = false;
  let canvasScale = 1;
  let mapFrameDecodeBusy = false;
  const heroIconCache = new Map();

  function getHeroIcon(heroId) {
    if (!heroId) return null;
    const key = String(heroId);
    let img = heroIconCache.get(key);
    if (!img) {
      img = new Image();
      img.src = `/assets/heroes/${encodeURIComponent(key)}.png`;
      heroIconCache.set(key, img);
    }
    return img;
  }

  function setupCanvasResolution() {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    if (dpr === canvasScale) return;
    canvasScale = dpr;
    canvas.width = Math.round(LOGICAL_MAP_SIZE * dpr);
    canvas.height = Math.round(LOGICAL_MAP_SIZE * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in ctx) {
      ctx.imageSmoothingQuality = "high";
    }
    renderMap();
  }

  function status(text) {
    $("status").textContent = text;
  }

  function consumePendingMapFrame() {
    if (mapFrameDecodeBusy || !socketState.pendingMapFrame) return;
    const task = socketState.pendingMapFrame;
    socketState.pendingMapFrame = null;
    mapFrameDecodeBusy = true;
    const image = new Image();
    image.onload = () => {
      socketState.mapFrameImage = image;
      socketState.mapFrameKey = task.key;
      mapFrameDecodeBusy = false;
      renderMap();
      consumePendingMapFrame();
    };
    image.onerror = () => {
      mapFrameDecodeBusy = false;
      consumePendingMapFrame();
    };
    image.src = `data:${task.mime};base64,${task.data}`;
  }

  function updateMapFrame(frame) {
    const mf = frame?.mapFrame;
    if (!mf || !mf.data) return;
    const key = `${mf.ts || 0}:${mf.data.length}`;
    if (key === socketState.mapFrameKey) return;
    socketState.pendingMapFrame = {
      key,
      mime: mf.mime || "image/jpeg",
      data: mf.data
    };
    consumePendingMapFrame();
  }

  function setButtonText(id, text) {
    const button = $(id);
    if (!button) return;
    const span = button.querySelector(".btn-text");
    if (span) {
      span.textContent = text;
      return;
    }
    button.textContent = text;
  }

  function notice(text) {
    $("notice").textContent = text;
    $("notice").hidden = !text;
  }

  function sanitizeRoom(code) {
    return String(code || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 6);
  }

  function syncURL() {
    const params = new URLSearchParams(location.search);
    params.delete("room");
    params.delete("compact");
    if (document.body.classList.contains("compact")) params.set("compact", "1");
    const basePath = socketState.room ? `/${encodeURIComponent(socketState.room)}` : "/";
    history.replaceState(null, "", basePath + (params.size ? "?" + params.toString() : ""));
  }

  function updateShare() {
    const room = socketState.room;
    const share = room
      ? `${location.origin}/${encodeURIComponent(room)}`
      : `${location.origin}/`;
    $("share-url").textContent = share;
  }

  function waitingText() {
    return "Chờ iPhone phát bản đồ";
  }

  function setPerspectiveText(text) {
    $("perspective").textContent = text;
  }

  function disconnect() {
    clearTimeout(socketState.retry);
    socketState.retry = 0;
    const prev = socketState.ws;
    socketState.ws = null;
    prev?.close();
  }

  function resetFrame() {
    socketState.frame = null;
    socketState.lastSeq = 0;
    socketState.mapFrameKey = "";
    socketState.mapFrameImage = null;
    socketState.pendingMapFrame = null;
    mapFrameDecodeBusy = false;
    socketState.lastReceived = 0;
    $("age").textContent = "Chưa có dữ liệu";
    renderMap();
  }

  function chooseRoom(code, writeURL = true) {
    disconnect();
    socketState.room = sanitizeRoom(code);
    $("room").textContent = socketState.room || "—";
    const codeInput = $("code");
    if (codeInput) codeInput.value = socketState.room;
    updateShare();
    resetFrame();
    setPerspectiveText("Chờ luồng từ iPhone");
    notice("");
    status(socketState.room ? "Đang kết nối..." : "Chưa kết nối");
    if (writeURL) syncURL();
    if (socketState.room.length === 6) connect(socketState.room);
  }

  function parsePayload(msg) {
    const entities = Array.isArray(msg?.payload?.entities)
      ? msg.payload.entities
      : [];
    const metaCamp = Number(msg?.payload?.meta?.selfTeam || 0);
    const selfEntity = entities.find((entity) => entity?.isSelf);
    const inferredCamp = Number(selfEntity?.team || 0);
    return {
      camp: metaCamp > 0 ? metaCamp : inferredCamp,
      actorCount: entities.length,
      entities: entities.map((entity) => ({
        id: String(entity?.id || ""),
        heroId: Number(entity?.heroId || 0),
        team: Number(entity?.team || 0),
        x: Number(entity?.x || 0),
        y: Number(entity?.y || 0),
        hp: Number(entity?.hp || 0),
        maxHp: Number(entity?.maxHp || 1),
        dead: !!entity?.dead,
        visible: entity?.visible !== false,
        isSelf: !!entity?.isSelf
      })),
      mapFrame: msg?.payload?.mapFrame && typeof msg.payload.mapFrame === "object"
        ? {
            mime: String(msg.payload.mapFrame.mime || "image/jpeg"),
            data: String(msg.payload.mapFrame.data || ""),
            ts: Number(msg.payload.mapFrame.ts || 0)
          }
        : null
    };
  }

  function connect(room) {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws?match=${encodeURIComponent(room)}`);
    socketState.ws = ws;

    ws.onopen = () => {
      if (socketState.ws !== ws) return;
      status(waitingText());
      ws.send(JSON.stringify({ type: "subscribe", matchId: room }));
    };

    ws.onmessage = (event) => {
      if (socketState.ws !== ws) return;

      if (typeof event.data === "string") {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === "snapshot" && payload.matchId === room) {
            const seq = Number(payload.seq || 0);
            if (seq > 0 && seq <= socketState.lastSeq) return;
            if (seq > 0) socketState.lastSeq = seq;
            const parsed = parsePayload(payload);
            if (!parsed) return;
            socketState.frame = parsed;
            socketState.lastReceived = performance.now();
            updateMapFrame(parsed);
            const count = parsed.actorCount;
            status(count ? "Đang phát dữ liệu" : "Đã kết nối, chờ trận");
            const hasLiveFrame = !!parsed.mapFrame?.data;
            setPerspectiveText(hasLiveFrame
              ? (parsed.camp
                  ? `Góc nhìn Team ${parsed.camp} • Minimap trực tiếp từ game`
                  : "Đang nhận minimap trực tiếp")
              : (parsed.camp
                  ? `Góc nhìn Team ${parsed.camp} • Minimap render dữ liệu`
                  : "Đang nhận minimap realtime"));
            $("age").textContent = "Cập nhật vài giây trước";
            renderMap();
            if (document.hidden && pipState()) renderMap();
          } else if (payload.type === "pong" && Number.isFinite(payload.at)) {
            const rtt = performance.now() - payload.at;
          }
        } catch (_err) {}
      }
    };

    ws.onclose = () => {
      if (socketState.ws !== ws) return;
      socketState.ws = null;
      status("Luồng phát đã dừng / phòng chưa mở");
      setPerspectiveText("Chờ luồng từ iPhone");
      resetFrame();
      socketState.retry = setTimeout(() => {
        if (socketState.room === room && !socketState.ws) connect(room);
      }, 2500);
    };

    ws.onerror = () => {
      if (socketState.ws === ws) status("Không kết nối được phòng");
    };
  }

  function pipVideo() {
    if (video) return video;
    video = document.createElement("video");
    video.id = "pip-video";
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.setAttribute("aria-hidden", "true");
    video.tabIndex = -1;
    document.body.append(video);
    return video;
  }

  function pipState() {
    return (
      !!video &&
      (document.pictureInPictureElement === video ||
        video.webkitPresentationMode === "picture-in-picture")
    );
  }

  function syncPipButton() {
    clearInterval(pipTimer);
    pipTimer = 0;
    const open = pipState();
    setButtonText("pip", open ? "Đóng PiP" : "PiP");
    $("pip").setAttribute("aria-pressed", String(open));
    if (mobile) {
      setButtonText("popup", open ? "Đóng cửa sổ nổi" : "Cửa sổ nổi");
      $("popup").setAttribute("aria-pressed", String(open));
    }
    if (open) pipTimer = setInterval(renderMap, 16);
  }

  async function togglePip() {
    if (pipBusy) return;
    notice("");
    if (!socketState.room && !pipState()) {
      notice("Nhập mã phòng và chọn Xem map trước khi mở cửa sổ nổi.");
      return;
    }
    pipBusy = true;
    $("pip").disabled = true;
    if (mobile) $("popup").disabled = true;
    try {
      const v = pipVideo();
      if (pipState()) {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else if (v.webkitPresentationMode === "picture-in-picture") {
          v.webkitSetPresentationMode("inline");
        }
      } else {
        const stream = canvas.captureStream(60);
        if (v.srcObject !== stream) v.srcObject = stream;
        await v.play();
        if (v.requestPictureInPicture) {
          await v.requestPictureInPicture();
        } else if (v.webkitSupportsPresentationMode?.("picture-in-picture")) {
          v.webkitSetPresentationMode("picture-in-picture");
        } else {
          notice("Trình duyệt chưa hỗ trợ PiP.");
        }
      }
    } catch (_err) {
      notice("Không mở được cửa sổ nổi PiP.");
    } finally {
      pipBusy = false;
      $("pip").disabled = false;
      if (mobile) $("popup").disabled = false;
      syncPipButton();
    }
  }

  function background(showLiveFrame) {
    if (showLiveFrame && socketState.mapFrameImage) {
      ctx.fillStyle = "#0b1220";
      ctx.fillRect(0, 0, LOGICAL_MAP_SIZE, LOGICAL_MAP_SIZE);
      ctx.save();
      const prevSmooth = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      ctx.filter = "contrast(1.22) saturate(1.16) brightness(1.08)";
      ctx.drawImage(socketState.mapFrameImage, 0, 0, LOGICAL_MAP_SIZE, LOGICAL_MAP_SIZE);
      ctx.imageSmoothingEnabled = prevSmooth;
      ctx.restore();
      return;
    }

    ctx.fillStyle = "#0b1220";
    ctx.fillRect(0, 0, LOGICAL_MAP_SIZE, LOGICAL_MAP_SIZE);
    const cell = 44;
    ctx.strokeStyle = "rgba(166, 194, 232, 0.16)";
    ctx.lineWidth = 1;
    for (let p = 0; p <= LOGICAL_MAP_SIZE; p += cell) {
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, LOGICAL_MAP_SIZE);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(LOGICAL_MAP_SIZE, p);
      ctx.stroke();
    }
  }

  function drawActors(frame, enemyOnly = false) {
    if (!frame || !Array.isArray(frame.entities)) return;
    for (const actor of frame.entities) {
      if (actor.dead) continue;
      if (!enemyOnly && !actor.visible) continue;
      if (enemyOnly && (actor.isSelf || (frame.camp > 0 && actor.team === frame.camp))) continue;
      const x = Math.max(0, Math.min(1, actor.x)) * LOGICAL_MAP_SIZE;
      const y = Math.max(0, Math.min(1, actor.y)) * LOGICAL_MAP_SIZE;
      const ally = actor.team === frame.camp;
      const self = actor.isSelf;
      const radius = enemyOnly ? 14 : (self ? 10 : 7);

      if (enemyOnly) {
        const icon = getHeroIcon(actor.heroId);
        if (icon?.complete && icon.naturalWidth > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(icon, x - radius, y - radius, radius * 2, radius * 2);
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.fillStyle = "#ff445e";
          ctx.arc(x, y, radius - 3, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.strokeStyle = "rgba(255, 64, 92, 0.98)";
        ctx.lineWidth = 3;
        ctx.arc(x, y, radius + 1, 0, Math.PI * 2);
        ctx.stroke();
        continue;
      }

      ctx.beginPath();
      ctx.fillStyle = self ? "#ffd36a" : ally ? "#47d9a3" : "#ff6e82";
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.strokeStyle = "rgba(9, 14, 24, 0.85)";
      ctx.lineWidth = 2;
      ctx.arc(x, y, radius + 1, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function setMapMessage(text) {
    const message = $("map-message");
    if (!message) return;
    message.textContent = text;
  }

  function setLiveBadge(isLive) {
    const badge = document.querySelector(".status-live");
    if (!badge) return;
    badge.classList.toggle("offline", !isLive);
    badge.classList.toggle("online", isLive);
    badge.innerHTML = isLive
      ? '<i class="bi bi-broadcast-pin"></i> ONLINE'
      : '<i class="bi bi-broadcast-pin"></i> OFFLINE';
  }

  function renderMap() {
    const frame = socketState.frame;
    const age = socketState.lastReceived ? performance.now() - socketState.lastReceived : Infinity;
    const live = !!frame && age < 3000;
    setLiveBadge(live);
    background(live);
    $("map-panel").classList.toggle("is-waiting", !live);
    $("map-message").hidden = socketState.room && live;
    if (!live) {
      setMapMessage("Chờ iPhone phát bản đồ");
    }
    $("age").textContent =
      socketState.lastReceived && age < 3000
        ? "Cập nhật " + Math.round(age) + " ms trước"
        : socketState.lastReceived
          ? "Luồng phát đã dừng"
          : "Chưa có dữ liệu";

    if (!live) return;
    const hasLiveMapFrame = !!socketState.mapFrameImage;
    drawActors(frame, hasLiveMapFrame);
    return;
  }

  const joinForm = $("joinForm");
  const codeInput = $("code");
  const resetRoomButton = $("reset-room");
  if (joinForm && codeInput && resetRoomButton) {
    joinForm.addEventListener("submit", (e) => {
      e.preventDefault();
      chooseRoom(codeInput.value, true);
    });

    codeInput.addEventListener("input", () => {
      codeInput.value = sanitizeRoom(codeInput.value);
    });

    resetRoomButton.onclick = () => chooseRoom("", true);
  }

  $("compact").onclick = () => {
    document.body.classList.toggle("compact");
    setButtonText("compact", document.body.classList.contains("compact") ? "Mở rộng" : "Thu gọn");
    syncURL();
  };

  const expandButton = $("expand");
  if (expandButton) {
    expandButton.onclick = () => {
      document.body.classList.remove("compact");
      setButtonText("compact", "Thu gọn");
      syncURL();
    };
  }

  $("popup").onclick = () => {
    if (mobile) {
      togglePip();
      return;
    }
    notice("");
    if (!socketState.room) {
      notice("Vào phòng trước khi mở cửa sổ nhỏ");
      return;
    }
    const url = `/${encodeURIComponent(socketState.room)}?compact=1`;
    if (!window.open(url, "vthangios-map", "popup,width=380,height=455,resizable=yes")) {
      notice("Trình duyệt đang chặn cửa sổ bật lên");
    }
  };

  $("pip").onclick = togglePip;

  $("fullscreen").onclick = async () => {
    notice("");
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      if ($("map-panel").requestFullscreen) {
        await $("map-panel").requestFullscreen();
      } else {
        document.body.classList.toggle("compact");
        setButtonText("compact", document.body.classList.contains("compact") ? "Mở rộng" : "Thu gọn");
      }
    } catch (_err) {
      notice("Không mở được toàn màn hình");
    }
  };

  $("copy-link").onclick = async () => {
    const text = $("share-url").textContent || location.href;
    try {
      await navigator.clipboard.writeText(text);
      setButtonText("copy-link", "Đã copy");
      setTimeout(() => {
        setButtonText("copy-link", "Copy Link");
      }, 900);
    } catch (_err) {
      notice("Không copy được link");
    }
  };

  addEventListener("visibilitychange", () => {
    if (document.hidden && pipState()) renderMap();
  });

  addEventListener("pagehide", (e) => {
    disconnect();
    clearInterval(pipTimer);
    if (!e.persisted) {
      video?.srcObject?.getTracks().forEach((t) => t.stop());
    }
  });

  addEventListener("resize", setupCanvasResolution);

  function readURL() {
    const params = new URLSearchParams(location.search);
    let room = params.get("room") || "";
    const shortPathMatch = location.pathname.match(/^\/([A-Za-z0-9]{6})$/);
    const legacyPathMatch = location.pathname.match(/\/webmap\/([A-Za-z0-9]{6})$/);
    const roomFromPath = !room
      ? shortPathMatch
        ? shortPathMatch[1]
        : legacyPathMatch
          ? legacyPathMatch[1]
          : ""
      : "";
    if (roomFromPath) room = roomFromPath;

    const viewerMode = !!roomFromPath;
    document.body.classList.toggle("viewer-mode", viewerMode);
    document.body.classList.toggle("compact", params.get("compact") === "1");
    setButtonText("compact", document.body.classList.contains("compact") ? "Mở rộng" : "Thu gọn");
    chooseRoom(room, false);
  }

  if (mobile) {
    setButtonText("popup", "Cửa sổ nổi");
    $("popup").title = "Hiển thị bản đồ trên ứng dụng khác";
  }
  if (android && $("android-pip-help")) {
    $("android-pip-help").hidden = false;
  }

  setInterval(() => {
    if (socketState.ws?.readyState === WebSocket.OPEN) {
      socketState.ws.send(JSON.stringify({ type: "ping", at: performance.now() }));
    }
    renderMap();
  }, 2000);

  setupCanvasResolution();
  readURL();
  updateShare();
  syncPipButton();
  renderMap();
})();
