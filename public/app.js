(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const canvas = $("map");
  const ctx = canvas.getContext("2d");
  const LOGICAL_MAP_SIZE = 900;
  const MAP_ASSET = "/assets/";

  const android = /Android/i.test(navigator.userAgent);
  const mobile =
    android ||
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  const icons = {};
  const heroIconCache = new Map();
  const socketState = {
    ws: null,
    retry: 0,
    room: "",
    lastReceived: 0,
    frame: null,
    mapFrameKey: "",
    mapFrameImage: null
  };

  let video = null;
  let pipTimer = 0;
  let pipBusy = false;
  let mapImageLoaded = false;
  let canvasScale = 1;

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

  function updateMapFrame(frame) {
    const mf = frame?.mapFrame;
    if (!mf || !mf.data) return;
    const key = `${mf.ts || 0}:${mf.data.length}`;
    if (key === socketState.mapFrameKey) return;
    socketState.mapFrameKey = key;
    const image = new Image();
    image.onload = () => {
      socketState.mapFrameImage = image;
      renderMap();
    };
    image.src = `data:${mf.mime || "image/jpeg"};base64,${mf.data}`;
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
    if (socketState.room) params.set("room", socketState.room);
    if (document.body.classList.contains("compact")) params.set("compact", "1");
    history.replaceState(null, "", "/webmap" + (params.size ? "?" + params.toString() : ""));
  }

  function updateShare() {
    const room = socketState.room;
    const share = room
      ? `${location.origin}/webmap/${encodeURIComponent(room)}`
      : `${location.origin}/webmap`;
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
    socketState.mapFrameKey = "";
    socketState.mapFrameImage = null;
    socketState.lastReceived = 0;
    $("age").textContent = "Chưa có dữ liệu";
    $("latency").textContent = "RTT —";
    renderMap();
  }

  function chooseRoom(code, writeURL = true) {
    disconnect();
    socketState.room = sanitizeRoom(code);
    $("room").textContent = socketState.room || "—";
    $("code").value = socketState.room;
    updateShare();
    resetFrame();
    setPerspectiveText("Chờ luồng từ iPhone");
    notice("");
    status(socketState.room ? "Đang kết nối..." : "Chưa kết nối");
    if (writeURL) syncURL();
    if (socketState.room.length === 6) connect(socketState.room);
  }

  function parsePayload(msg) {
    const entities = msg?.payload?.entities;
    if (!Array.isArray(entities)) return null;
    const parseHeroId = (entity) => {
      const direct = Number(entity?.heroId);
      if (Number.isFinite(direct) && direct > 0) return direct;
      const nameMatch = String(entity?.name || "").match(/hero_(\d+)/i);
      if (nameMatch) return Number(nameMatch[1]);
      return 0;
    };
    return {
      camp: Number(msg?.payload?.meta?.selfTeam || 0),
      mapFrame: msg?.payload?.mapFrame && typeof msg.payload.mapFrame === "object"
        ? {
            mime: String(msg.payload.mapFrame.mime || "image/jpeg"),
            data: String(msg.payload.mapFrame.data || ""),
            ts: Number(msg.payload.mapFrame.ts || 0)
          }
        : null,
      actors: entities.map((e) => ({
        id: String(e.id || ""),
        name: String(e.name || ""),
        heroId: parseHeroId(e),
        hp: Number(e.hp || 0),
        max: Number(e.maxHp || 1),
        x: Number(e.x || 0),
        y: Number(e.y || 0),
        team: Number(e.team || 0),
        dead: Boolean(e.dead)
      }))
    };
  }

  function getHeroIcon(heroId) {
    if (!Number.isFinite(heroId) || heroId <= 0) return null;
    if (heroIconCache.has(heroId)) {
      const cached = heroIconCache.get(heroId);
      return cached.loaded ? cached.image : null;
    }

    const image = new Image();
    const holder = { image, loaded: false };
    heroIconCache.set(heroId, holder);
    image.onload = () => {
      holder.loaded = true;
      renderMap();
    };
    image.onerror = () => {
      heroIconCache.set(heroId, { image: null, loaded: false, failed: true });
    };
    image.src = `${MAP_ASSET}heroes/${heroId}.png`;
    return null;
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
            const parsed = parsePayload(payload);
            if (!parsed) return;
            socketState.frame = parsed;
            socketState.lastReceived = performance.now();
            updateMapFrame(parsed);
            const count = parsed.actors.length;
            status(count ? "Đang phát dữ liệu" : "Đã kết nối, chờ trận");
            setPerspectiveText(parsed.camp ? `Góc nhìn Team ${parsed.camp}` : "Đang nhận dữ liệu trực tiếp");
            $("age").textContent = "Cập nhật vài giây trước";
            renderMap();
            if (document.hidden && pipState()) renderMap();
          } else if (payload.type === "pong" && Number.isFinite(payload.at)) {
            const rtt = performance.now() - payload.at;
            $("latency").textContent = "RTT " + (rtt < 1 ? "<1" : Math.round(rtt)) + " ms";
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
    if (open) pipTimer = setInterval(renderMap, 33);
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
        const stream = canvas.captureStream(30);
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

  function toCanvas(x01, y01) {
    return { x: x01 * LOGICAL_MAP_SIZE, y: (1 - y01) * LOGICAL_MAP_SIZE };
  }

  function background() {
    ctx.fillStyle = "#182734";
    ctx.fillRect(0, 0, LOGICAL_MAP_SIZE, LOGICAL_MAP_SIZE);
    if (socketState.mapFrameImage) {
      ctx.save();
      const prevSmooth = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      ctx.filter = "contrast(1.22) saturate(1.16) brightness(1.08)";
      ctx.drawImage(socketState.mapFrameImage, 0, 0, LOGICAL_MAP_SIZE, LOGICAL_MAP_SIZE);
      ctx.imageSmoothingEnabled = prevSmooth;
      ctx.restore();
    } else if (mapImageLoaded) {
      ctx.drawImage(icons.terrain, 0, 0, LOGICAL_MAP_SIZE, LOGICAL_MAP_SIZE);
    }
  }

  function drawActor(actor, camp) {
    const p = toCanvas(actor.x, actor.y);
    const ally = camp && actor.team === camp;
    const color = ally ? "#5acbde" : "#e9797d";
    const heroIcon = getHeroIcon(actor.heroId);

    ctx.globalAlpha = actor.dead ? 0.35 : 1;
    if (heroIcon) {
      const size = 26;
      const half = size / 2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, half, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(heroIcon, p.x - half, p.y - half, size, size);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(p.x, p.y, half + 2, 0, Math.PI * 2);
      ctx.strokeStyle = ally ? "#86ecff" : "#ff9ca0";
      ctx.lineWidth = 2.5;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,.85)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    const rate = Math.max(0, Math.min(1, actor.hp / Math.max(1, actor.max)));
    ctx.fillStyle = "#16151fcc";
    ctx.fillRect(p.x - 20, p.y - 18, 40, 5);
    ctx.fillStyle = ally ? "#63cbdc" : "#e37d81";
    ctx.fillRect(p.x - 20, p.y - 18, 40 * rate, 5);
    ctx.globalAlpha = 1;
  }

  function renderMap() {
    background();
    const frame = socketState.frame;
    const age = socketState.lastReceived ? performance.now() - socketState.lastReceived : Infinity;
    const live = !!frame && age < 3000;
    $("map-message").hidden = socketState.room && live;
    if (!socketState.room) $("map-message").textContent = "Nhập mã phòng để xem bản đồ";
    else if (!live) $("map-message").textContent = "Chờ dữ liệu từ iPhone";
    $("age").textContent =
      socketState.lastReceived && age < 3000
        ? "Cập nhật " + Math.round(age) + " ms trước"
        : socketState.lastReceived
          ? "Luồng phát đã dừng"
          : "Chưa có dữ liệu";

    if (!live) return;
    if (socketState.mapFrameImage) return;
    for (const actor of frame.actors) {
      drawActor(actor, frame.camp);
    }
  }

  $("joinForm").addEventListener("submit", (e) => {
    e.preventDefault();
    chooseRoom($("code").value, true);
  });

  $("code").addEventListener("input", () => {
    $("code").value = sanitizeRoom($("code").value);
  });

  $("reset-room").onclick = () => chooseRoom("", true);

  $("compact").onclick = () => {
    document.body.classList.toggle("compact");
    setButtonText("compact", document.body.classList.contains("compact") ? "Mở rộng" : "Thu gọn");
    syncURL();
  };

  $("expand").onclick = () => {
    document.body.classList.remove("compact");
    setButtonText("compact", "Thu gọn");
    syncURL();
  };

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
    const url = `/webmap/?room=${encodeURIComponent(socketState.room)}&compact=1`;
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
    if (!room) {
      const pathMatch = location.pathname.match(/\/webmap\/([A-Za-z0-9]{6})$/);
      room = pathMatch ? pathMatch[1] : "";
    }
    document.body.classList.toggle("compact", params.get("compact") === "1");
    setButtonText("compact", document.body.classList.contains("compact") ? "Mở rộng" : "Thu gọn");
    chooseRoom(room, false);
  }

  icons.terrain = new Image();
  icons.terrain.onload = () => {
    mapImageLoaded = true;
    renderMap();
  };
  icons.terrain.onerror = () => {
    mapImageLoaded = false;
    renderMap();
  };
  icons.terrain.src = MAP_ASSET + "icons/terrain.png";

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
