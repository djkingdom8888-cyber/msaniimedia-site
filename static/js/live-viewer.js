// Viewer page: receives the host's composed broadcast over WebRTC, shows
// live chat, and lets a viewer ask to join on camera. The viewer's own
// RTCPeerConnection to the host (see live-host.js's handleGuestOffer) is
// established immediately on request, NOT after approval -- this is what
// lets the host actually preview the requester's live camera/mic before
// deciding. Nothing reaches other viewers until the host approves; declining
// just tears this preview connection back down.
(function () {
  const ROOM = window.LIVE_ROOM;
  const socket = io();

  const hostVideo = document.getElementById("host-video");
  const stageWaiting = document.getElementById("stage-waiting");
  const chatMessages = document.getElementById("chat-messages");
  const chatInput = document.getElementById("chat-input");
  const chatSend = document.getElementById("chat-send");
  const requestBtn = document.getElementById("request-camera-btn");
  const cameraStatus = document.getElementById("camera-status");
  const nameModal = document.getElementById("name-modal");
  const nameInput = document.getElementById("name-input");
  const nameSubmit = document.getElementById("name-submit");
  const statusBadge = document.getElementById("status-badge");
  const switchCameraBtn = document.getElementById("switch-camera-btn");

  let myName = sessionStorage.getItem("mm_viewer_name") || "";
  let broadcastPc = null;
  let hostSid = null;
  let guestPc = null;
  let localGuestStream = null;
  let guestFacingMode = "user";
  let pendingGuestIce = []; // ICE candidates generated before we learn the host's sid

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function appendChatLine(name, message) {
    const div = document.createElement("div");
    div.className = "msg";
    div.innerHTML = `<strong>${escapeHtml(name)}</strong>${escapeHtml(message)}`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function joinRoom() {
    nameModal.style.display = "none";
    socket.emit("join_room", { room: ROOM, role: "viewer", name: myName });
  }

  if (myName) {
    joinRoom();
  } else {
    nameSubmit.onclick = () => {
      const v = nameInput.value.trim();
      if (!v) return;
      myName = v;
      sessionStorage.setItem("mm_viewer_name", v);
      joinRoom();
    };
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") nameSubmit.click(); });
  }

  socket.on("chat_history", (data) => {
    chatMessages.innerHTML = "";
    (data.messages || []).forEach((m) => appendChatLine(m.sender_name, m.message));
  });
  socket.on("chat_message", (data) => appendChatLine(data.name, data.message));

  // ---------------- Waiting-for-host overlay ----------------
  // The status badge alone isn't enough feedback: without this, a viewer can
  // see the badge flip to "LIVE" while the video area still says "Waiting
  // for the host..." (stale), or -- if WebRTC can never establish (no TURN
  // server configured here, STUN only, so some NATs will simply fail) --
  // sits on that same stale text forever with no error shown at all.
  let watchdogTimer = null;
  let gotTrack = false;

  function clearWatchdog() {
    if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
  }

  function showOverlay(text, isError) {
    if (!stageWaiting) return;
    stageWaiting.textContent = text;
    stageWaiting.classList.remove("hidden");
    stageWaiting.classList.toggle("overlay-error", !!isError);
  }

  function hideOverlay() {
    if (stageWaiting) stageWaiting.classList.add("hidden");
  }

  function armWatchdog() {
    clearWatchdog();
    gotTrack = false;
    watchdogTimer = setTimeout(() => {
      if (!gotTrack) {
        showOverlay("Having trouble connecting to the stream — try refreshing.", true);
      }
    }, 15000);
  }

  // Set the overlay's initial text to match whatever status the page was
  // rendered with (a viewer can load this page directly on an already-live
  // or already-ended room, not just via the listing page).
  if (window.LIVE_STATUS === "live") {
    showOverlay("Host is live — connecting video…");
  } else if (window.LIVE_STATUS === "ended") {
    showOverlay("This session has ended.");
  } else {
    showOverlay("Waiting for the host to go live…");
  }

  socket.on("live_status", (data) => {
    statusBadge.textContent = data.status.toUpperCase();
    statusBadge.className = "status-badge " + data.status;
    if (data.status === "live") {
      showOverlay("Host is live — connecting video…");
    } else {
      clearWatchdog();
      showOverlay("Waiting for the host to go live…");
      // Host ended (or hasn't started) the session -- nothing left to share,
      // so stop holding the phone's screen awake.
      releaseWakeLock();
    }
  });

  // ---------------- Receiving the host's broadcast ----------------
  socket.on("webrtc_signal", (data) => {
    if (data.kind === "broadcast" && data.type === "offer") {
      hostSid = data.from;
      broadcastPc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      armWatchdog();
      broadcastPc.ontrack = (e) => {
        hostVideo.srcObject = e.streams[0];
        gotTrack = true;
        clearWatchdog();
        hideOverlay();
      };
      broadcastPc.oniceconnectionstatechange = () => {
        const state = broadcastPc.iceConnectionState;
        if (state === "failed") {
          gotTrack = false;
          clearWatchdog();
          showOverlay("Having trouble connecting to the stream — try refreshing.", true);
        } else if ((state === "connected" || state === "completed") && !gotTrack) {
          // Connected at the network layer but no media frame yet -- give it
          // a little longer rather than declaring success or failure.
        }
      };
      broadcastPc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit("webrtc_signal", { to: hostSid, kind: "broadcast", type: "ice", candidate: e.candidate });
        }
      };
      broadcastPc.setRemoteDescription(new RTCSessionDescription(data.sdp)).then(() => {
        return broadcastPc.createAnswer();
      }).then((answer) => {
        broadcastPc.setLocalDescription(answer);
        socket.emit("webrtc_signal", { to: hostSid, kind: "broadcast", type: "answer", sdp: answer });
      });
    } else if (data.kind === "broadcast" && data.type === "ice") {
      if (broadcastPc) broadcastPc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
    } else if (data.kind === "guest" && data.type === "guest-answer") {
      if (guestPc) {
        guestPc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (!hostSid) hostSid = data.from;
        if (pendingGuestIce.length) {
          pendingGuestIce.forEach((c) => socket.emit("webrtc_signal", { to: hostSid, kind: "guest", type: "ice", candidate: c }));
          pendingGuestIce = [];
        }
      }
    } else if (data.kind === "guest" && data.type === "ice") {
      if (guestPc) guestPc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
    }
  });

  // ---------------- Asking to join on camera ----------------
  // iOS Safari (and most mobile browsers) will dim then lock the screen on
  // its normal auto-lock timer even while a page is actively using the
  // camera -- once the screen locks, WebKit suspends the page and the
  // camera stream/WebRTC connection dies with it. This is exactly what "the
  // camera times off after 5 seconds and goes blank" was: nothing in our
  // signaling broke, the PHONE went to sleep out from under it. The fix is
  // the standard Screen Wake Lock API (supported iOS Safari 16.4+): hold a
  // lock for as long as the person is sharing their camera (pending
  // approval OR already approved), release it the moment they stop sharing
  // for any reason. A wake lock is auto-released by the browser whenever
  // the tab is backgrounded/hidden, so it must be explicitly re-acquired on
  // visibilitychange if we're still supposed to be holding it.
  let wakeLock = null;
  let wantWakeLock = false;

  async function acquireWakeLock() {
    wantWakeLock = true;
    if (!("wakeLock" in navigator) || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } catch (e) {
      // Not supported, or denied (e.g. Low Power Mode) -- nothing else we
      // can do client-side; the camera still works, it just may sleep.
    }
  }

  function releaseWakeLock() {
    wantWakeLock = false;
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && wantWakeLock) acquireWakeLock();
  });

  requestBtn.onclick = async () => {
    requestBtn.disabled = true;
    cameraStatus.textContent = "Requesting access to your camera…";
    try {
      localGuestStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: guestFacingMode } },
        audio: true,
      });
    } catch (e) {
      cameraStatus.textContent = "Camera/mic access denied.";
      requestBtn.disabled = false;
      return;
    }
    acquireWakeLock();
    cameraStatus.textContent = "Connecting so the host can preview you…";
    startGuestConnection();
  };

  socket.on("camera_response", (data) => {
    if (!data.approve) {
      cameraStatus.textContent = "The host declined your request to join.";
      requestBtn.disabled = false;
      releaseWakeLock();
      if (guestPc) { try { guestPc.close(); } catch (e) { /* already closed */ } guestPc = null; }
      if (localGuestStream) { localGuestStream.getTracks().forEach((t) => t.stop()); localGuestStream = null; }
      return;
    }
    cameraStatus.textContent = "You're live! The host can now see and hear you.";
    if (switchCameraBtn) switchCameraBtn.classList.remove("hidden");
  });

  // Unlike the host's own camera (which only feeds a canvas the host redraws
  // locally), this stream is sent directly over guestPc -- so switching the
  // camera here means replacing the actual outgoing track on the connection,
  // not just swapping what a <video> element shows.
  if (switchCameraBtn) {
    switchCameraBtn.onclick = async () => {
      if (!guestPc || !localGuestStream) return;
      const nextFacing = guestFacingMode === "user" ? "environment" : "user";
      switchCameraBtn.disabled = true;
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: nextFacing } },
        });
        const newTrack = newStream.getVideoTracks()[0];
        const sender = guestPc.getSenders().find((s) => s.track && s.track.kind === "video");
        if (sender) await sender.replaceTrack(newTrack);
        const oldTrack = localGuestStream.getVideoTracks()[0];
        localGuestStream.removeTrack(oldTrack);
        oldTrack.stop();
        localGuestStream.addTrack(newTrack);
        guestFacingMode = nextFacing;
      } catch (err) {
        alert("Couldn't switch camera: " + err.message);
      } finally {
        switchCameraBtn.disabled = false;
      }
    };
  }

  function startGuestConnection() {
    guestPc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    localGuestStream.getTracks().forEach((track) => guestPc.addTrack(track, localGuestStream));
    guestPc.onicecandidate = (e) => {
      if (!e.candidate) return;
      // We may not know the host's sid yet (it arrives on the guest-answer,
      // not before) -- buffer until then instead of dropping candidates.
      if (hostSid) {
        socket.emit("webrtc_signal", { to: hostSid, kind: "guest", type: "ice", candidate: e.candidate });
      } else {
        pendingGuestIce.push(e.candidate);
      }
    };
    guestPc.createOffer().then((offer) => {
      guestPc.setLocalDescription(offer);
      socket.emit("camera_offer", { room: ROOM, name: myName, sdp: offer });
    });
  }

  chatSend.onclick = sendChat;
  chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
  function sendChat() {
    const message = chatInput.value.trim();
    if (!message || !myName) return;
    socket.emit("chat_message", { room: ROOM, name: myName, message });
    chatInput.value = "";
  }
})();
