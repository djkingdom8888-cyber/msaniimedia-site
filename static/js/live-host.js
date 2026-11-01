// Host console: captures the host's camera, composites it (plus an optional
// approved guest camera) onto a canvas, and broadcasts that composed stream
// to every viewer over its own RTCPeerConnection. Signaling is relayed
// through the Flask-SocketIO server (see app.py's webrtc_signal handler) —
// the server never touches media, only forwards SDP/ICE JSON between sids.
(function () {
  const ROOM = window.LIVE_ROOM;
  const socket = io();

  const canvas = document.getElementById("compose-canvas");
  // willReadFrequently: the filter pass below calls getImageData every frame
  // once live -- this hint keeps Chromium/WebKit from re-optimizing the
  // context for GPU compositing only, which would make that call much slower.
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const selfPreview = document.getElementById("self-preview");
  const goLiveBtn = document.getElementById("go-live-btn");
  const endLiveBtn = document.getElementById("end-live-btn");
  const camRequestsBox = document.getElementById("camera-requests");
  const chatMessages = document.getElementById("chat-messages");
  const chatInput = document.getElementById("chat-input");
  const chatSend = document.getElementById("chat-send");
  const statusBadge = document.getElementById("status-badge");
  const switchCameraBtn = document.getElementById("switch-camera-btn");
  const filterSelect = document.getElementById("filter-select");
  const cameraSourceSelect = document.getElementById("camera-source-select");
  const shareWindowBtn = document.getElementById("share-window-btn");
  let selectedDeviceId = null; // explicit device pick; null = browser default

  // ---- Broadcast Destinations (RTMP fan-out to Facebook/YouTube/Twitch/TikTok) ----
  const manageDestinationsBtn = document.getElementById("manage-destinations-btn");
  const broadcastToggleBtn = document.getElementById("broadcast-toggle-btn");
  const destinationsSummaryEl = document.getElementById("destinations-summary");
  const broadcastStatusEl = document.getElementById("broadcast-status");
  const destinationsDialogBackdrop = document.getElementById("destinations-dialog-backdrop");
  const destinationsListEl = document.getElementById("destinations-list");
  const destinationsListHeaderEl = document.getElementById("destinations-list-header");
  const addDestinationBtn = document.getElementById("add-destination-btn");
  const destinationsDoneBtn = document.getElementById("destinations-done-btn");

  // Filters used to be applied via ctx.filter = "<css filter string>" at
  // draw time. That property is unreliable on WebKit/iOS Safari -- multi-
  // function filter strings frequently render as a silent no-op there even
  // though the property exists, which is exactly the "picking a filter does
  // nothing" bug this replaces. To get identical, guaranteed behavior on
  // every platform (desktop, Safari, iOS, Android), each filter is instead
  // precomputed as a single 3x3 color matrix + bias (composing the whole
  // recipe -- saturate, contrast, brightness, etc, in order) and applied by
  // hand to the composited frame's raw pixels once per frame via
  // getImageData/putImageData. Pure arithmetic, no browser filter API
  // involved, so it can't silently fail to apply.
  function mulM(a, b) {
    const r = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3 + 0] * b[0 * 3 + j] + a[i * 3 + 1] * b[1 * 3 + j] + a[i * 3 + 2] * b[2 * 3 + j];
    }
    return r;
  }
  function mulMV(m, v) { return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]; }
  function addV(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  // Composes "apply (M1,b1) first, then (M2,b2)" into one matrix/bias pair:
  // out = M2*(M1*x + b1) + b2 = (M2*M1)*x + (M2*b1 + b2)
  function compose(M2, b2, M1, b1) { return { M: mulM(M2, M1), b: addV(mulMV(M2, b1), b2) }; }
  const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  function brightnessOp(amt) { return { M: [amt, 0, 0, 0, amt, 0, 0, 0, amt], b: [0, 0, 0] }; }
  function contrastOp(amt) { const k = (1 - amt) * 128; return { M: [amt, 0, 0, 0, amt, 0, 0, 0, amt], b: [k, k, k] }; }
  function saturateOp(s) {
    return {
      M: [
        0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
        0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
        0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
      ], b: [0, 0, 0],
    };
  }
  function grayscaleOp() { return { M: [0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722], b: [0, 0, 0] }; }
  function sepiaOp(amt) {
    const full = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];
    return { M: full.map((v, i) => IDENTITY[i] * (1 - amt) + v * amt), b: [0, 0, 0] };
  }
  function hueRotateOp(deg) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return {
      M: [
        0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
        0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
        0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
      ], b: [0, 0, 0],
    };
  }
  function chainOps(ops) {
    let cur = { M: IDENTITY, b: [0, 0, 0] };
    for (const op of ops) cur = compose(op.M, op.b, cur.M, cur.b);
    return cur;
  }
  // Same recipes as before (matching the original CSS filter strings), minus
  // dreamy's blur(0.4px) -- too subtle to matter and not worth a per-frame
  // convolution pass; the color grade is what actually reads as "dreamy".
  const FILTER_OPS = {
    none: null,
    vivid: chainOps([saturateOp(1.5), contrastOp(1.12), brightnessOp(1.03)]),
    mono: chainOps([grayscaleOp(), contrastOp(1.1)]),
    noir: chainOps([grayscaleOp(), contrastOp(1.45), brightnessOp(0.92)]),
    warm: chainOps([sepiaOp(0.35), saturateOp(1.35), brightnessOp(1.05)]),
    cool: chainOps([saturateOp(1.15), hueRotateOp(-8), brightnessOp(1.02), contrastOp(1.05)]),
    dreamy: chainOps([brightnessOp(1.1), contrastOp(0.92), saturateOp(1.15)]),
  };
  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
  function applyFrameFilter(name) {
    const op = FILTER_OPS[name];
    if (!op) return; // "none" (or an unrecognized name) -- leave the frame untouched
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = frame.data;
    const M = op.M, b = op.b;
    const m0 = M[0], m1 = M[1], m2 = M[2], m3 = M[3], m4 = M[4], m5 = M[5], m6 = M[6], m7 = M[7], m8 = M[8];
    const b0 = b[0], b1 = b[1], b2 = b[2];
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], bl = d[i + 2];
      d[i] = clamp255(m0 * r + m1 * g + m2 * bl + b0);
      d[i + 1] = clamp255(m3 * r + m4 * g + m5 * bl + b1);
      d[i + 2] = clamp255(m6 * r + m7 * g + m8 * bl + b2);
    }
    ctx.putImageData(frame, 0, 0);
  }
  let currentFilter = filterSelect ? filterSelect.value : "vivid";
  let currentFacingMode = "user"; // "user" = front/selfie camera, "environment" = back camera

  let hostStream = null;
  let finalStream = null; // composed video (canvas) + mixed audio, sent to viewers & recorded
  let audioCtx = null;
  let mixDestination = null;
  // Every approved guest gets its own RTCPeerConnection + hidden <video> element,
  // keyed by socket id. The draw loop below tiles however many of these are
  // currently connected (plus the host) into a grid — this is what makes the
  // screen "divide into two or more depending on participants."
  const guestConnections = new Map(); // sid -> { pc, video, name }
  // A requester's peer connection is live (so the host can preview them) before
  // any approve/decline decision is made. Entries here are NOT drawn to the
  // canvas and their audio is NOT mixed into the broadcast -- only
  // approveGuest() promotes an entry into guestConnections, at which point it
  // starts appearing for viewers.
  const pendingGuests = new Map(); // sid -> { pc, video, name, requestId, stream }
  const viewerConnections = {}; // sid -> RTCPeerConnection (host is offerer, broadcasting finalStream)
  let mediaRecorder = null;
  let recordedChunks = [];
  let isLive = false;

  function appendChatLine(name, message) {
    const div = document.createElement("div");
    div.className = "msg";
    div.innerHTML = `<strong>${escapeHtml(name)}</strong>${escapeHtml(message)}`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------------- Camera + canvas compositing loop ----------------
  // Builds the audio-mix graph and canvas capture exactly once, regardless
  // of whether hostStream ended up holding a real camera or a shared
  // window/screen -- both paths below call this after they have SOME
  // hostStream, so neither depends on the other having run first.
  function setupAudioAndCanvas() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      mixDestination = audioCtx.createMediaStreamDestination();
    }
    // hostStream may be video-only (e.g. a window share where the mic
    // couldn't be grabbed) -- createMediaStreamSource() throws hard on a
    // stream with no audio track, so only wire it up if one actually
    // exists. The broadcast still works fine with no audio in that case.
    if (hostStream.getAudioTracks().length > 0) {
      audioCtx.createMediaStreamSource(hostStream).connect(mixDestination);
    }
    if (finalStream) return; // canvas/finalStream/drawLoop already running

    const canvasStream = canvas.captureStream(30);
    finalStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...mixDestination.stream.getAudioTracks(),
    ]);

    drawLoop();
  }

  async function initCamera() {
    const videoConstraint = selectedDeviceId
      ? { deviceId: { exact: selectedDeviceId } }
      : { facingMode: { ideal: currentFacingMode } };
    hostStream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraint,
      audio: true,
    });
    selfPreview.srcObject = hostStream;
      selfPreview.play().catch(() => {});
    await populateCameraSources();
    setupAudioAndCanvas();
    renderAudioSources();
  }

  // Swaps the host's own camera between front/back. This never needs to touch
  // any RTCPeerConnection: what viewers actually receive is the CANVAS's
  // captured stream, and the canvas just draws whatever `selfPreview` shows
  // right now -- so re-pointing selfPreview at a new video track is the whole
  // fix. The mic (and the AudioContext node already wired to it) is left
  // completely alone.
  async function switchCamera() {
    if (!hostStream) return;
    const nextFacing = currentFacingMode === "user" ? "environment" : "user";
    switchCameraBtn.disabled = true;
    try {
      const newVideoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: nextFacing } },
      });
      const newTrack = newVideoStream.getVideoTracks()[0];
      const oldTrack = hostStream.getVideoTracks()[0];
      hostStream.removeTrack(oldTrack);
      oldTrack.stop();
      hostStream.addTrack(newTrack);
      selfPreview.srcObject = hostStream; // re-assign so the element notices the swap
      selfPreview.play().catch(() => {});
      currentFacingMode = nextFacing;
    } catch (err) {
      alert("Couldn't switch camera: " + err.message);
    } finally {
      switchCameraBtn.disabled = false;
    }
  }
  if (switchCameraBtn) switchCameraBtn.onclick = switchCamera;

  // Lists every video input the browser can see (webcams, phone-continuity
  // cameras, virtual cameras if one happens to be installed) so the host can
  // explicitly pick one instead of relying on facingMode guessing.
  async function populateCameraSources() {
    if (!cameraSourceSelect || !navigator.mediaDevices.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === "videoinput");
    const previousValue = cameraSourceSelect.value;
    cameraSourceSelect.innerHTML = "";
    cams.forEach((d, i) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `Camera ${i + 1}`;
      cameraSourceSelect.appendChild(opt);
    });
    const stillPresent = cams.some((d) => d.deviceId === previousValue);
    if (stillPresent) {
      cameraSourceSelect.value = previousValue;
    } else {
      const obsCam = cams.find((d) => /obs virtual camera/i.test(d.label));
      if (obsCam) cameraSourceSelect.value = obsCam.deviceId;
    }
    selectedDeviceId = cameraSourceSelect.value || null;
  }
  if (navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", populateCameraSources);
  }

  async function switchToSelectedSource() {
    if (!hostStream || !cameraSourceSelect.value) return;
    selectedDeviceId = cameraSourceSelect.value;
    cameraSourceSelect.disabled = true;
    try {
      const newVideoStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: selectedDeviceId } },
      });
      const newTrack = newVideoStream.getVideoTracks()[0];
      const oldTrack = hostStream.getVideoTracks()[0];
      hostStream.removeTrack(oldTrack);
      oldTrack.stop();
      hostStream.addTrack(newTrack);
      selfPreview.srcObject = hostStream;
      selfPreview.play().catch(() => {});
    } catch (err) {
      alert("Couldn't switch to that source: " + err.message);
    } finally {
      cameraSourceSelect.disabled = false;
    }
  }
  if (cameraSourceSelect) cameraSourceSelect.onchange = switchToSelectedSource;

  // Captures a specific window/screen directly through the browser's own
  // native picker (no virtual-camera driver needed) -- the straightforward
  // way to put a desktop switcher's output window (e.g. KingdomProd Media's
  // "Output" window) on the broadcast when a virtual-camera bridge isn't
  // available or isn't working on this machine.
  async function shareWindow() {
    shareWindowBtn.disabled = true;
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const newTrack = displayStream.getVideoTracks()[0];

      // This is deliberately NOT gated on hostStream already existing --
      // sharing a window is a full alternative to the camera, not something
      // that requires the camera to have worked first. If initCamera()
      // hasn't produced a stream yet (still waiting on a permission prompt,
      // denied, no camera present, whatever), build hostStream fresh here
      // instead of silently doing nothing.
      if (!hostStream) {
        let micTrack = null;
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          micTrack = micStream.getAudioTracks()[0];
        } catch (err) {
          console.warn("No mic available for window share, continuing video-only:", err);
        }
        hostStream = new MediaStream(micTrack ? [newTrack, micTrack] : [newTrack]);
      } else {
        const oldTrack = hostStream.getVideoTracks()[0];
        hostStream.removeTrack(oldTrack);
        oldTrack.stop();
        hostStream.addTrack(newTrack);
      }
      selfPreview.srcObject = hostStream;
      selfPreview.play().catch(() => {});
      setupAudioAndCanvas();
      // The browser's own "Stop sharing" control (or closing the shared
      // window) ends the track -- fall back to the camera rather than
      // leaving the broadcast on a dead track.
      // Falls back to a real camera -- deliberately a plain video-track
      // swap (like switchCamera/switchToSelectedSource above), NOT a call
      // to initCamera(), which would re-run audio setup and double-connect
      // the mic into the mix.
      newTrack.onended = async () => {
        alert("Window sharing stopped -- switching back to camera. (If you didn't click \"Stop sharing\" yourself, the shared window may have closed or been minimized.)");
        try {
          const fallbackConstraint = cameraSourceSelect && cameraSourceSelect.value
            ? { deviceId: { exact: cameraSourceSelect.value } }
            : { facingMode: { ideal: currentFacingMode } };
          const fallbackStream = await navigator.mediaDevices.getUserMedia({ video: fallbackConstraint });
          const fallbackTrack = fallbackStream.getVideoTracks()[0];
          const deadTrack = hostStream.getVideoTracks()[0];
          hostStream.removeTrack(deadTrack);
          deadTrack.stop();
          hostStream.addTrack(fallbackTrack);
          selfPreview.srcObject = hostStream;
      selfPreview.play().catch(() => {});
        } catch (err) {
          console.error("Couldn't fall back to camera after window share ended:", err);
        }
      };
    } catch (err) {
      if (err.name !== "NotAllowedError") {
        alert("Couldn't start window sharing: " + err.message);
      }
    } finally {
      shareWindowBtn.disabled = false;
    }
  }
  if (shareWindowBtn) shareWindowBtn.onclick = shareWindow;

  if (filterSelect) {
    filterSelect.onchange = () => { currentFilter = filterSelect.value; };
  }

  // "Cover"-style draw (like CSS object-fit: cover): fills the target cell
  // without squishing the source video's aspect ratio, cropping instead.
  function drawCover(videoEl, x, y, w, h) {
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.max(w / vw, h / vh);
    const sw = w / scale, sh = h / scale;
    const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
    ctx.drawImage(videoEl, sx, sy, sw, sh, x, y, w, h);
  }

  // Switcher state: null = equal auto-grid (old behavior). Set to "host" or
  // a guest's sid to make that one tile fill the main view, with everyone
  // else demoted to a thumbnail strip along the bottom -- same idea as
  // KingdomProd Media's "click a tile to put it on Program" switcher.
  let mainTileKey = null;
  function setMainTile(key) {
    mainTileKey = mainTileKey === key ? null : key; // click again to go back to equal grid
    renderAudioSources();
  }

  function getTiles() {
    const tiles = [{ key: "host", el: selfPreview, name: window.HOST_NAME || "Host" }];
    guestConnections.forEach((g, sid) => tiles.push({ key: sid, el: g.video, name: g.name || "Guest" }));
    return tiles;
  }

  function drawTileFrame(tile, x, y, w, h, isMain) {
    if (tile.el.readyState >= 2) {
      drawCover(tile.el, x, y, w, h);
    }
    ctx.save();
    ctx.strokeStyle = isMain ? "#ffd23b" : (tile.key === "host" ? "rgba(255,255,255,0.25)" : "#ff3b4e");
    ctx.lineWidth = isMain ? 3 : 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    ctx.font = "16px sans-serif";
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    const labelW = ctx.measureText(tile.name).width + 16;
    ctx.fillRect(x + 8, y + h - 32, labelW, 24);
    ctx.fillStyle = "#fff";
    ctx.fillText(tile.name, x + 16, y + h - 14);
    ctx.restore();
  }

  function drawLoop() {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Tile 0 is always the host. Every connected guest adds another tile —
    // the grid reflows live as people join or leave, no fixed layout.
    const tiles = getTiles();
    const mainTile = mainTileKey && tiles.find((t) => t.key === mainTileKey);

    if (mainTile) {
      // Main-speaker layout: one large view, everyone else as a thumbnail
      // strip along the bottom (skipped entirely if it's just the host alone).
      const others = tiles.filter((t) => t.key !== mainTileKey);
      const stripH = others.length ? Math.round(canvas.height * 0.22) : 0;
      drawTileFrame(mainTile, 0, 0, canvas.width, canvas.height - stripH, true);
      if (others.length) {
        const thumbW = canvas.width / others.length;
        others.forEach((tile, i) => {
          drawTileFrame(tile, i * thumbW, canvas.height - stripH, thumbW, stripH, false);
        });
      }
    } else {
      // No main picked: equal auto-grid, same as before.
      const total = tiles.length;
      const cols = Math.ceil(Math.sqrt(total));
      const rows = Math.ceil(total / cols);
      const cellW = canvas.width / cols;
      const cellH = canvas.height / rows;
      tiles.forEach((tile, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        drawTileFrame(tile, col * cellW, row * cellH, cellW, cellH, false);
      });
    }

    // Applied once to the whole composited frame (grid + borders + labels)
    // rather than per-tile before -- one getImageData/putImageData pass is
    // far cheaper than N of them, and still applies to every guest tile
    // automatically since it runs after all of them are drawn.
    applyFrameFilter(currentFilter);

    requestAnimationFrame(drawLoop);
  }

  // ---------------- Broadcasting to viewers ----------------
  function createViewerConnection(viewerSid) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    finalStream.getTracks().forEach((track) => pc.addTrack(track, finalStream));
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit("webrtc_signal", { to: viewerSid, kind: "broadcast", type: "ice", candidate: e.candidate });
      }
    };
    viewerConnections[viewerSid] = pc;
    pc.createOffer().then((offer) => {
      pc.setLocalDescription(offer);
      socket.emit("webrtc_signal", { to: viewerSid, kind: "broadcast", type: "offer", sdp: offer });
    });
    return pc;
  }

  // ---------------- Guest cameras (viewer -> host), one connection per guest ----------------
  // The peer connection is established as soon as a request comes in, NOT on
  // approval -- this is what lets the host actually see/hear the requester
  // (via the visible preview video in the request row) before deciding.
  // Nothing here reaches viewers yet: the video element isn't drawn by
  // drawLoop and the audio isn't wired into mixDestination until approveGuest()
  // promotes the entry into guestConnections.
  function handleGuestOffer(fromSid, sdp, name, requestId) {
    if (pendingGuests.has(fromSid) || guestConnections.has(fromSid)) return; // duplicate offer, ignore

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = false; // host can hear the requester too while deciding

    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit("webrtc_signal", { to: fromSid, kind: "guest", type: "ice", candidate: e.candidate });
      }
    };
    pc.ontrack = (e) => {
      video.srcObject = e.streams[0];
      const entry = pendingGuests.get(fromSid) || guestConnections.get(fromSid);
      if (entry) entry.stream = e.streams[0];
    };
    pc.onconnectionstatechange = () => {
      if (["disconnected", "failed", "closed"].includes(pc.connectionState)) {
        removeAnyGuest(fromSid);
      }
    };

    pendingGuests.set(fromSid, { pc, video, name, requestId });

    pc.setRemoteDescription(new RTCSessionDescription(sdp)).then(() => {
      return pc.createAnswer();
    }).then((answer) => {
      pc.setLocalDescription(answer);
      socket.emit("webrtc_signal", { to: fromSid, kind: "guest", type: "guest-answer", sdp: answer });
    });

    renderCameraRequestRow(fromSid, name, requestId, video);
  }

  // Host clicked "Approve": the connection is already live, so this just
  // promotes it into the set drawLoop composites and wires its audio into the
  // broadcast mix -- nothing needs to be renegotiated.
  function approveGuest(sid) {
    const entry = pendingGuests.get(sid);
    if (!entry) return;
    pendingGuests.delete(sid);
    entry.video.style.display = "none";
    document.body.appendChild(entry.video); // keep playing, out of the (removed) request row
    if (entry.stream) {
      audioCtx.createMediaStreamSource(entry.stream).connect(mixDestination);
    }
    guestConnections.set(sid, { pc: entry.pc, video: entry.video, name: entry.name, stream: entry.stream });
    renderAudioSources();
  }

  // ---------------- Per-camera mute (host + every approved guest) ----------------
  // Audio is mixed through the Web Audio graph above (host mic + each guest's
  // stream both feed mixDestination), but a MediaStreamTrack with
  // enabled=false outputs silence into any node sourced from it -- so muting
  // is just toggling .enabled on the right track, no graph rewiring needed.
  const audioSourcesListEl = document.getElementById("audio-sources-list");
  function renderAudioSources() {
    if (!audioSourcesListEl) return;
    audioSourcesListEl.innerHTML = "";

    const sources = [];
    const hostAudioTrack = hostStream && hostStream.getAudioTracks()[0];
    if (hostStream) sources.push({ key: "host", name: window.HOST_NAME || "Host", track: hostAudioTrack });
    guestConnections.forEach((g, sid) => {
      const track = g.stream && g.stream.getAudioTracks()[0];
      sources.push({ key: sid, name: g.name || "Guest", track });
    });

    sources.forEach(({ key, name, track }) => {
      const row = document.createElement("div");
      row.className = "audio-source-row";
      const label = document.createElement("span");
      label.textContent = name;
      row.appendChild(label);

      const mainBtn = document.createElement("button");
      mainBtn.type = "button";
      mainBtn.className = "btn btn-sm btn-outline";
      const paintMain = () => { const isMain = mainTileKey === key; mainBtn.textContent = isMain ? "★ Main" : "Make Main"; mainBtn.classList.toggle("is-main", isMain); };
      paintMain();
      mainBtn.onclick = () => { setMainTile(key); };
      row.appendChild(mainBtn);

      if (track) {
        const muteBtn = document.createElement("button");
        muteBtn.type = "button";
        muteBtn.className = "btn btn-sm btn-outline";
        const paintMute = () => { muteBtn.textContent = track.enabled ? "🎤 Mute" : "🔇 Unmute"; muteBtn.classList.toggle("is-muted", !track.enabled); };
        paintMute();
        muteBtn.onclick = () => { track.enabled = !track.enabled; paintMute(); };
        row.appendChild(muteBtn);
      }
      audioSourcesListEl.appendChild(row);
    });
  }

  // Host clicked "Decline": tear down the preview connection. Nothing was
  // ever broadcast, so there's nothing else to undo.
  function declineGuest(sid) {
    const entry = pendingGuests.get(sid);
    if (!entry) return;
    pendingGuests.delete(sid);
    try { entry.pc.close(); } catch (e) { /* already closed */ }
  }

  function removeGuest(sid) {
    const g = guestConnections.get(sid);
    if (!g) return;
    try { g.pc.close(); } catch (e) { /* already closed */ }
    if (g.video.parentNode) g.video.parentNode.removeChild(g.video);
    guestConnections.delete(sid);
    if (mainTileKey === sid) mainTileKey = null; // the main speaker just left -- fall back to the grid
    renderAudioSources();
  }

  // Connection dropped before a decision was ever made (pending) vs. after
  // approval (already live in the broadcast) need different cleanup.
  function removeAnyGuest(sid) {
    if (pendingGuests.has(sid)) {
      const entry = pendingGuests.get(sid);
      pendingGuests.delete(sid);
      try { entry.pc.close(); } catch (e) { /* already closed */ }
      const row = document.getElementById(`cam-req-${sid}`);
      if (row) row.remove();
    } else {
      removeGuest(sid);
    }
  }

  function renderCameraRequestRow(sid, name, requestId, videoEl) {
    const row = document.createElement("div");
    row.className = "camera-request-row";
    row.id = `cam-req-${sid}`;

    videoEl.className = "camera-preview-video";
    row.appendChild(videoEl);

    const info = document.createElement("span");
    info.className = "camera-request-info";
    info.innerHTML = `🎥 <strong>${escapeHtml(name)}</strong> wants to join on camera`;
    row.appendChild(info);

    const actions = document.createElement("span");
    actions.className = "actions";

    const approveBtn = document.createElement("button");
    approveBtn.className = "btn btn-primary btn-sm";
    approveBtn.textContent = "Approve";
    approveBtn.onclick = () => {
      socket.emit("respond_camera", { room: ROOM, request_id: requestId, approve: true });
      approveGuest(sid);
      row.remove();
    };

    const denyBtn = document.createElement("button");
    denyBtn.className = "btn btn-outline btn-sm";
    denyBtn.textContent = "Deny";
    denyBtn.style.marginLeft = "6px";
    denyBtn.onclick = () => {
      socket.emit("respond_camera", { room: ROOM, request_id: requestId, approve: false });
      declineGuest(sid);
      row.remove();
    };

    actions.appendChild(approveBtn);
    actions.appendChild(denyBtn);
    row.appendChild(actions);
    camRequestsBox.appendChild(row);
  }

  // ---------------- Broadcast Destinations (RTMP fan-out) ----------------
  // Mirrors kingdomprodmedia's "Manage Destinations" dialog UX (platform
  // dropdown, stream key / full RTMP URL field, enable toggle, remember-key
  // opt-in) but implemented here in plain Jinja/vanilla JS against this
  // project's own Flask endpoints (app.py's /live/<room>/destinations and
  // /broadcast/start|stop|status) instead of Electron IPC. The actual
  // fan-out (ffmpeg `-f tee`) happens server-side in lib/stream_relay.py --
  // this file's only job is managing destination rows and, once streaming,
  // handing the server a continuous feed of the SAME composed finalStream
  // every viewer already gets, via a second, dedicated MediaRecorder.
  let streamPlatformPresets = [];
  let destinations = []; // server-shape rows: {id, name, platform, rtmp_url, stream_key, enabled, remember_key}
  let broadcastRecorder = null;
  let isBroadcasting = false;
  let broadcastStatusPollTimer = null;

  function platformPreset(platformId) {
    return streamPlatformPresets.find((p) => p.id === platformId) || null;
  }

  function renderDestinationsSummary() {
    if (!destinations.length) {
      destinationsSummaryEl.textContent = "No destinations configured";
      broadcastToggleBtn.disabled = true;
      return;
    }
    const enabled = destinations.filter((d) => d.enabled);
    const labels = enabled.map((d) => (platformPreset(d.platform) || {}).label || d.name).filter(Boolean);
    destinationsSummaryEl.textContent = enabled.length
      ? `${enabled.length} of ${destinations.length} enabled: ${labels.join(", ")}`
      : `${destinations.length} destination(s), none enabled`;
    broadcastToggleBtn.disabled = !(isLive && finalStream && enabled.length > 0) || isBroadcasting === "pending";
  }

  async function loadDestinations() {
    try {
      const [presetsRes, destRes] = await Promise.all([
        fetch("/api/stream-platforms").then((r) => r.json()),
        fetch(`/live/${ROOM}/destinations`).then((r) => r.json()),
      ]);
      streamPlatformPresets = presetsRes.platforms || [];
      destinations = destRes.destinations || [];
      renderDestinationsSummary();
    } catch (err) {
      console.error("Failed to load broadcast destinations:", err);
    }
  }

  async function createDestination() {
    const preset = platformPreset("custom");
    const res = await fetch(`/live/${ROOM}/destinations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `Destination ${destinations.length + 1}`,
        platform: "custom",
        rtmp_url: (preset && preset.rtmp_url) || "",
        stream_key: "",
        enabled: true,
        remember_key: false,
      }),
    });
    const data = await res.json();
    if (data.ok) destinations.push(data.destination);
    return data;
  }

  async function patchDestination(destId, fields) {
    const res = await fetch(`/live/${ROOM}/destinations/${destId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    const data = await res.json();
    if (data.ok) {
      const idx = destinations.findIndex((d) => d.id === destId);
      if (idx !== -1) destinations[idx] = data.destination;
    }
    return data;
  }

  async function removeDestination(destId) {
    await fetch(`/live/${ROOM}/destinations/${destId}`, { method: "DELETE" });
    destinations = destinations.filter((d) => d.id !== destId);
  }

  function renderDestinationRows() {
    destinationsListEl.innerHTML = "";
    if (!destinations.length) {
      if (destinationsListHeaderEl) destinationsListHeaderEl.style.display = "none";
      const hint = document.createElement("p");
      hint.style.cssText = "color:var(--muted); font-size:13px;";
      hint.textContent = "No destinations yet — click \"+ Add Destination\" below, then use the Platform dropdown to pick Twitch, YouTube, Facebook, TikTok, or Custom RTMP.";
      destinationsListEl.appendChild(hint);
      return;
    }
    if (destinationsListHeaderEl) destinationsListHeaderEl.style.display = "grid";
    destinations.forEach((dest) => {
      const row = document.createElement("div");
      row.className = "destination-row" + (dest.enabled ? "" : " is-disabled");

      const enabledToggle = document.createElement("input");
      enabledToggle.type = "checkbox";
      enabledToggle.checked = dest.enabled;
      enabledToggle.title = "Enabled";

      const platformSelect = document.createElement("select");
      streamPlatformPresets.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.label;
        if (p.id === dest.platform) opt.selected = true;
        platformSelect.appendChild(opt);
      });

      const preset = platformPreset(dest.platform);
      const isLockedPreset = !!(preset && preset.rtmp_url);

      const urlInput = document.createElement("input");
      urlInput.type = "text";
      urlInput.autocomplete = "off";
      urlInput.value = dest.rtmp_url || "";
      urlInput.readOnly = isLockedPreset;
      urlInput.placeholder = dest.platform === "tiktok" ? "Full RTMP URL from TikTok LIVE Studio" : "RTMP URL";

      const keyInput = document.createElement("input");
      keyInput.type = "password";
      keyInput.autocomplete = "off";
      keyInput.value = dest.stream_key || "";
      keyInput.placeholder = "Stream key";

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn btn-sm btn-outline";
      removeBtn.textContent = "Remove";

      const extraRow = document.createElement("div");
      extraRow.className = "dest-extra-row";
      const rememberLabel = document.createElement("label");
      const rememberCheckbox = document.createElement("input");
      rememberCheckbox.type = "checkbox";
      rememberCheckbox.checked = dest.remember_key;
      rememberLabel.appendChild(rememberCheckbox);
      rememberLabel.appendChild(document.createTextNode(" Remember this key on this device"));
      extraRow.appendChild(rememberLabel);

      row.appendChild(enabledToggle);
      row.appendChild(platformSelect);
      row.appendChild(urlInput);
      row.appendChild(keyInput);
      row.appendChild(removeBtn);
      row.appendChild(extraRow);
      destinationsListEl.appendChild(row);

      enabledToggle.addEventListener("change", async () => {
        dest.enabled = enabledToggle.checked;
        row.classList.toggle("is-disabled", !dest.enabled);
        await patchDestination(dest.id, { enabled: dest.enabled });
        renderDestinationsSummary();
      });
      platformSelect.addEventListener("change", async () => {
        dest.platform = platformSelect.value;
        const p = platformPreset(dest.platform);
        if (p && p.rtmp_url) dest.rtmp_url = p.rtmp_url;
        await patchDestination(dest.id, { platform: dest.platform, rtmp_url: dest.rtmp_url });
        renderDestinationsSummary();
        renderDestinationRows(); // reflect the new platform's readOnly/placeholder
      });
      urlInput.addEventListener("blur", async () => {
        dest.rtmp_url = urlInput.value.trim();
        await patchDestination(dest.id, { rtmp_url: dest.rtmp_url });
      });
      keyInput.addEventListener("blur", async () => {
        dest.stream_key = keyInput.value.trim();
        await patchDestination(dest.id, { stream_key: dest.stream_key, remember_key: dest.remember_key });
      });
      rememberCheckbox.addEventListener("change", async () => {
        dest.remember_key = rememberCheckbox.checked;
        await patchDestination(dest.id, { remember_key: dest.remember_key, stream_key: dest.stream_key });
      });
      removeBtn.addEventListener("click", async () => {
        await removeDestination(dest.id);
        renderDestinationsSummary();
        renderDestinationRows();
      });
    });
  }

  function openManageDestinationsDialog() {
    renderDestinationRows();
    destinationsDialogBackdrop.style.display = "flex";
  }
  function closeManageDestinationsDialog() {
    destinationsDialogBackdrop.style.display = "none";
    renderDestinationsSummary();
  }
  if (manageDestinationsBtn) manageDestinationsBtn.onclick = openManageDestinationsDialog;
  if (destinationsDoneBtn) destinationsDoneBtn.onclick = closeManageDestinationsDialog;
  if (destinationsDialogBackdrop) {
    destinationsDialogBackdrop.addEventListener("click", (e) => {
      if (e.target === destinationsDialogBackdrop) closeManageDestinationsDialog();
    });
  }
  if (addDestinationBtn) {
    addDestinationBtn.onclick = async () => {
      await createDestination();
      renderDestinationsSummary();
      renderDestinationRows();
    };
  }

  function pickBroadcastMimeType() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
    const candidates = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"];
    return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || "";
  }

  function setBroadcastUiState(state, detail) {
    const labels = { idle: "Start Stream", connecting: "Starting…", live: "Stop Stream", error: "Retry Start Stream" };
    broadcastToggleBtn.textContent = labels[state] || "Start Stream";
    broadcastToggleBtn.classList.toggle("btn-danger", state === "live");
    broadcastStatusEl.classList.toggle("is-live", state === "live");
    broadcastStatusEl.classList.toggle("is-error", state === "error");
    if (state === "live") {
      broadcastStatusEl.textContent = `Broadcasting live to ${detail || destinations.filter((d) => d.enabled).length} destination(s).`;
    } else if (state === "error") {
      broadcastStatusEl.textContent = "Broadcast error: " + (detail || "unknown error");
    } else if (state === "connecting") {
      broadcastStatusEl.textContent = "Connecting to destination(s)…";
    } else {
      broadcastStatusEl.textContent = "";
    }
  }

  async function startBroadcast() {
    if (!isLive || !finalStream) {
      alert("Go live first, then start the broadcast-out stream.");
      return;
    }
    const enabledCount = destinations.filter((d) => d.enabled).length;
    if (!enabledCount) {
      alert("Add and enable at least one destination first (Manage Destinations).");
      return;
    }
    broadcastToggleBtn.disabled = true;
    setBroadcastUiState("connecting");
    try {
      const res = await fetch(`/live/${ROOM}/broadcast/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destinations }),
      });
      const data = await res.json();
      if (!data.ok) {
        setBroadcastUiState("error", data.error);
        broadcastToggleBtn.disabled = false;
        return;
      }
      isBroadcasting = true;
      const mimeType = pickBroadcastMimeType();
      broadcastRecorder = mimeType
        ? new MediaRecorder(finalStream, { mimeType })
        : new MediaRecorder(finalStream);
      broadcastRecorder.ondataavailable = async (e) => {
        if (!e.data || e.data.size === 0 || !isBroadcasting) return;
        try {
          const buf = await e.data.arrayBuffer();
          socket.emit("stream_chunk", ROOM, buf);
        } catch (err) {
          console.error("Failed to relay a broadcast chunk:", err);
        }
      };
      broadcastRecorder.start(1000);
      setBroadcastUiState("live", data.destinations);
      broadcastToggleBtn.disabled = false;
      broadcastStatusPollTimer = setInterval(pollBroadcastStatus, 4000);
    } catch (err) {
      setBroadcastUiState("error", err.message);
      broadcastToggleBtn.disabled = false;
    }
  }

  async function stopBroadcast() {
    broadcastToggleBtn.disabled = true;
    isBroadcasting = false;
    if (broadcastStatusPollTimer) { clearInterval(broadcastStatusPollTimer); broadcastStatusPollTimer = null; }
    if (broadcastRecorder && broadcastRecorder.state !== "inactive") {
      try { broadcastRecorder.stop(); } catch (e) { /* already stopped */ }
    }
    broadcastRecorder = null;
    try {
      await fetch(`/live/${ROOM}/broadcast/stop`, { method: "POST" });
    } catch (err) {
      console.error("Failed to stop broadcast relay:", err);
    }
    setBroadcastUiState("idle");
    broadcastToggleBtn.disabled = false;
    renderDestinationsSummary();
  }

  async function pollBroadcastStatus() {
    try {
      const res = await fetch(`/live/${ROOM}/broadcast/status`);
      const data = await res.json();
      if (isBroadcasting && !data.active) {
        // ffmpeg exited on its own (e.g. a destination rejected the stream
        // key) -- surface it rather than silently looking "live" forever.
        isBroadcasting = false;
        if (broadcastStatusPollTimer) { clearInterval(broadcastStatusPollTimer); broadcastStatusPollTimer = null; }
        if (broadcastRecorder && broadcastRecorder.state !== "inactive") {
          try { broadcastRecorder.stop(); } catch (e) { /* already stopped */ }
        }
        broadcastRecorder = null;
        setBroadcastUiState("error", data.error || data.stderr_tail || "the broadcast relay stopped unexpectedly");
        broadcastToggleBtn.disabled = false;
      }
    } catch (err) {
      console.error("Broadcast status poll failed:", err);
    }
  }

  if (broadcastToggleBtn) {
    broadcastToggleBtn.onclick = () => {
      if (isBroadcasting) stopBroadcast();
      else startBroadcast();
    };
  }

  loadDestinations();

  // ---------------- Socket events ----------------
  socket.on("connect", () => {
    socket.emit("join_room", { room: ROOM, role: "host", name: window.HOST_NAME });
  });

  socket.on("presence", (data) => {
    if (data.role === "viewer" && isLive && finalStream && data.sid && !viewerConnections[data.sid]) {
      createViewerConnection(data.sid);
    }
  });

  socket.on("webrtc_signal", (data) => {
    if (data.kind === "broadcast" && data.type === "answer") {
      const pc = viewerConnections[data.from];
      if (pc) pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.kind === "broadcast" && data.type === "ice") {
      const pc = viewerConnections[data.from];
      if (pc) pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
    } else if (data.kind === "guest" && data.type === "ice") {
      const entry = pendingGuests.get(data.from) || guestConnections.get(data.from);
      if (entry) entry.pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
    }
  });

  socket.on("chat_history", (data) => {
    chatMessages.innerHTML = "";
    (data.messages || []).forEach((m) => appendChatLine(m.sender_name, m.message));
  });
  socket.on("chat_message", (data) => appendChatLine(data.name, data.message));

  socket.on("camera_offer", (data) => {
    handleGuestOffer(data.socket_id, data.sdp, data.name, data.request_id);
  });

  // ---------------- Controls ----------------
  chatSend.onclick = sendChat;
  chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
  function sendChat() {
    const message = chatInput.value.trim();
    if (!message) return;
    socket.emit("chat_message", { room: ROOM, name: window.HOST_NAME, message });
    chatInput.value = "";
  }

  // Acquire the camera (and populate the source dropdown) as soon as the
  // page loads, not only once "Go Live" is clicked -- the operator needs to
  // pick the right source (e.g. OBS Virtual Camera) and see a working
  // preview *before* committing to go live, not after.
  initCamera().catch((err) => {
    console.error("Camera init on load failed:", err);
  });

  goLiveBtn.onclick = async () => {
    goLiveBtn.disabled = true;
    goLiveBtn.textContent = "Starting…";
    try {
      if (!hostStream) await initCamera();
      isLive = true;
      socket.emit("host_go_live", { room: ROOM });
      statusBadge.textContent = "LIVE";
      statusBadge.className = "status-badge live";
      goLiveBtn.style.display = "none";
      endLiveBtn.disabled = false;

      recordedChunks = [];
      const vodMimeType = pickBroadcastMimeType();
      mediaRecorder = vodMimeType
        ? new MediaRecorder(finalStream, { mimeType: vodMimeType })
        : new MediaRecorder(finalStream);
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
      mediaRecorder.start(1000);
      renderDestinationsSummary(); // now that isLive+finalStream exist, "Start Stream" can enable
    } catch (err) {
      alert("Couldn't access camera/microphone: " + err.message);
      goLiveBtn.disabled = false;
      goLiveBtn.textContent = "▶ Go Live";
    }
  };

  endLiveBtn.onclick = async () => {
    endLiveBtn.disabled = true;
    endLiveBtn.textContent = "Saving…";
    isLive = false;
    if (isBroadcasting) await stopBroadcast();
    socket.emit("host_end_live", { room: ROOM });
    statusBadge.textContent = "ENDED";
    statusBadge.className = "status-badge ended";
    Object.values(viewerConnections).forEach((pc) => pc.close());
    Array.from(guestConnections.keys()).forEach(removeGuest);
    Array.from(pendingGuests.keys()).forEach(declineGuest);
    camRequestsBox.innerHTML = "";

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      await new Promise((resolve) => {
        mediaRecorder.onstop = resolve;
        mediaRecorder.stop();
      });
    }
    if (recordedChunks.length) {
      const blob = new Blob(recordedChunks, { type: "video/webm" });
      const formData = new FormData();
      formData.append("recording", blob, "recording.webm");
      try {
        await fetch(`/live/${ROOM}/upload-recording`, { method: "POST", body: formData });
        endLiveBtn.textContent = "Saved ✓";
      } catch (e) {
        endLiveBtn.textContent = "Save failed";
      }
    } else {
      endLiveBtn.textContent = "Ended";
    }
  };
})();
