// Browse-live-sessions page: the page is otherwise fully server-rendered
// (computed once at request time), so without this a viewer sitting on
// /live with the tab open gets zero indication when a host goes live or a
// scheduled session starts/ends. This polls a small JSON endpoint and moves
// each session's card between the Live/Scheduled/Replays sections, plus
// flashes a banner the moment something newly goes live.
(function () {
  const POLL_MS = 9000;

  const nowGrid = document.getElementById("live-now-grid");
  const nowEmpty = document.getElementById("live-now-empty");
  const scheduledGrid = document.getElementById("scheduled-grid");
  const scheduledEmpty = document.getElementById("scheduled-empty");
  const endedGrid = document.getElementById("ended-grid");
  const endedEmpty = document.getElementById("ended-empty");
  const banner = document.getElementById("live-just-went-live-banner");

  if (!nowGrid) return; // not on the /live page

  let knownStatus = {}; // room_code -> status, from the previous poll
  let firstPoll = true;
  let bannerTimer = null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function cardHtml(s) {
    if (s.status === "live") {
      return `<a class="media-card" data-room="${s.room_code}" href="/live/${s.room_code}">
        <div class="thumb"><span class="badge-kind" style="background:var(--accent);">● LIVE</span>📡</div>
        <div class="body"><h3>${escapeHtml(s.title)}</h3><p>Hosted by ${escapeHtml(s.host_name)}</p></div>
      </a>`;
    }
    if (s.status === "scheduled") {
      return `<div class="media-card" data-room="${s.room_code}">
        <div class="thumb"><span class="badge-kind">Scheduled</span>🗓️</div>
        <div class="body"><h3>${escapeHtml(s.title)}</h3><p>Hosted by ${escapeHtml(s.host_name)}</p></div>
      </div>`;
    }
    // ended (only shown if it has a recording)
    return `<a class="media-card" data-room="${s.room_code}" href="/live/${s.room_code}/replay">
      <div class="thumb"><span class="badge-kind">Replay</span>▶</div>
      <div class="body"><h3>${escapeHtml(s.title)}</h3><p>Hosted by ${escapeHtml(s.host_name)}</p></div>
    </a>`;
  }

  function setSection(grid, emptyEl, items) {
    if (items.length) {
      grid.innerHTML = items.map(cardHtml).join("");
      grid.style.display = "";
      if (emptyEl) emptyEl.style.display = "none";
    } else {
      grid.innerHTML = "";
      grid.style.display = "none";
      if (emptyEl) emptyEl.style.display = "";
    }
  }

  function showBanner(titles) {
    if (!banner) return;
    const label = titles.length === 1
      ? `🔴 "${titles[0]}" just went live!`
      : `🔴 ${titles.length} sessions just went live!`;
    banner.textContent = label;
    banner.classList.remove("hidden");
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => banner.classList.add("hidden"), 12000);
  }

  function poll() {
    fetch("/live/status.json", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        const sessions = data.sessions || [];
        const nextStatus = {};
        const newlyLive = [];

        sessions.forEach((s) => {
          nextStatus[s.room_code] = s.status;
          if (!firstPoll && s.status === "live" && knownStatus[s.room_code] !== "live") {
            newlyLive.push(s.title);
          }
        });

        setSection(nowGrid, nowEmpty, sessions.filter((s) => s.status === "live"));
        setSection(scheduledGrid, scheduledEmpty, sessions.filter((s) => s.status === "scheduled"));
        setSection(endedGrid, endedEmpty, sessions.filter((s) => s.status === "ended" && s.has_recording));

        if (newlyLive.length) showBanner(newlyLive);

        knownStatus = nextStatus;
        firstPoll = false;
      })
      .catch(() => { /* transient network hiccup -- try again on the next tick */ });
  }

  // Seed knownStatus from the server-rendered markup so the very first poll
  // doesn't falsely treat already-live sessions as "newly" live.
  document.querySelectorAll("#live-now-grid [data-room]").forEach((el) => {
    knownStatus[el.getAttribute("data-room")] = "live";
  });
  document.querySelectorAll("#scheduled-grid [data-room]").forEach((el) => {
    knownStatus[el.getAttribute("data-room")] = "scheduled";
  });
  document.querySelectorAll("#ended-grid [data-room]").forEach((el) => {
    knownStatus[el.getAttribute("data-room")] = "ended";
  });

  setInterval(poll, POLL_MS);
})();
