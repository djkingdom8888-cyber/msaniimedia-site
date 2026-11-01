"""Multi-destination RTMP broadcast-out (Facebook/YouTube/Twitch/TikTok at
once), ported from the proven pattern in the sibling project
kingdomprodmedia/lib/kpm-core.js (normalizeStreamDestination,
resolveEnabledStreamDestinations, buildFfmpegStreamArgs) -- same ffmpeg
`-f tee` single-encode fan-out, same real platform ingest URLs, just moved
from an Electron main-process child_process call to a Flask backend.

Transport differs out of necessity: kingdomprodmedia pipes MediaRecorder
chunks to ffmpeg's stdin over Electron IPC (same process tree). Here the
host's browser is a separate machine from the server, so the chunks travel
over a Socket.IO binary event (app.py's `stream_chunk` handler) instead --
but the actual ffmpeg input (`-f webm -i pipe:0`) and tee fan-out argv are
identical in shape to kpm-core.js's, and are proven against real local RTMP
listeners in tests/test_stream_relay.py the same way
kingdomprodmedia/test/streaming-multidest.test.js proves it there.

This module has two halves:
  - Pure, side-effect-free helpers (platform presets, destination
    normalization/validation, ffmpeg argv building) -- directly unit
    tested, no subprocess/network involved.
  - BroadcastRelay: the actual per-room ffmpeg subprocess lifecycle
    manager, used by app.py to start/stop/feed the real relay process.
"""
import queue
import shutil
import subprocess
import threading

# ---------------------------------------------------------------------
# Known-current platform RTMP ingest presets -- copied verbatim from
# kingdomprodmedia/lib/kpm-core.js's STREAM_PLATFORM_PRESETS (that file's
# own comment documents how each was sourced/verified on 2026-10-27):
#   - Twitch: Twitch's own public ingest-selection API, "Default"/global
#     auto-routing entry.
#   - YouTube: YouTube Studio's documented primary ingest.
#   - Facebook: Meta's documented secure RTMPS ingest for Facebook Live
#     Producer "stream key" setups.
#   - TikTok: deliberately NO preset URL -- TikTok LIVE Studio generates a
#     unique Server URL *and* Stream Key together per session, so the host
#     must paste the full RTMP URL fresh from TikTok LIVE Studio each time
#     (same UX as a "custom" destination).
# ---------------------------------------------------------------------
PLATFORM_PRESETS = {
    "twitch": {"label": "Twitch", "rtmp_url": "rtmp://ingest.global-contribute.live-video.net/app"},
    "youtube": {"label": "YouTube", "rtmp_url": "rtmp://a.rtmp.youtube.com/live2"},
    "facebook": {"label": "Facebook", "rtmp_url": "rtmps://live-api-s.facebook.com:443/rtmp/"},
    "tiktok": {"label": "TikTok", "rtmp_url": ""},
    "custom": {"label": "Custom", "rtmp_url": ""},
}


def list_stream_platform_presets():
    return [{"id": platform_id, **preset} for platform_id, preset in PLATFORM_PRESETS.items()]


def get_stream_platform_preset(platform_id):
    return PLATFORM_PRESETS.get(platform_id, PLATFORM_PRESETS["custom"])


def normalize_stream_destination(raw, index=0):
    """Normalizes one host-managed destination entry (from the UI or a DB
    row) to a complete, well-typed shape -- mirrors kpm-core.js's
    normalizeStreamDestination so a half-filled entry never reaches ffmpeg
    malformed."""
    raw = raw or {}
    platform = raw.get("platform")
    if not isinstance(platform, str) or not platform:
        platform = "custom"
    name = raw.get("name")
    name = name.strip() if isinstance(name, str) and name.strip() else "Destination {}".format(index + 1)
    rtmp_url = raw.get("rtmp_url")
    rtmp_url = rtmp_url.strip() if isinstance(rtmp_url, str) else ""
    stream_key = raw.get("stream_key")
    stream_key = stream_key if isinstance(stream_key, str) else ""
    # Default to enabled for a brand-new entry; an explicit `False` is the
    # only way to end up disabled.
    enabled = raw.get("enabled") is not False
    remember_key = bool(raw.get("remember_key"))
    return {
        "name": name,
        "platform": platform,
        "rtmp_url": rtmp_url,
        "stream_key": stream_key,
        "enabled": enabled,
        "remember_key": remember_key,
    }


def build_stream_destination(rtmp_url, stream_key):
    """Joins an ingest URL with a stream key into the full publish
    destination ffmpeg pushes to, trimming whitespace/trailing slashes so
    "url/" + "key" doesn't produce a double slash. None when there's no URL
    to push to at all."""
    url = (rtmp_url or "").strip()
    if not url:
        return None
    key = (stream_key or "").strip()
    base = url.rstrip("/")
    return "{}/{}".format(base, key) if key else base


def resolve_enabled_stream_destinations(destinations):
    """Narrows a host-managed destinations list down to the ordered list of
    real push URLs ffmpeg's tee muxer should fan out to -- only entries that
    are enabled AND have a usable RTMP URL. TikTok has no fixed ingest
    preset, so a TikTok destination with no rtmp_url pasted in yet is
    excluded (a bare stream key alone is never valid for it, unlike
    Twitch/YouTube/Facebook which have a fixed ingest host)."""
    urls = []
    for raw in destinations or []:
        d = normalize_stream_destination(raw)
        if not d["enabled"]:
            continue
        if d["platform"] == "tiktok" and not d["rtmp_url"]:
            continue
        dest = build_stream_destination(d["rtmp_url"], d["stream_key"])
        if dest:
            urls.append(dest)
    return urls


def build_tee_destination_spec(push_urls):
    """Builds the literal `-f tee` destination argument: each push URL
    wrapped in `[f=flv]<url>`, joined by `|`. None when there's nothing to
    push to."""
    urls = [u for u in (push_urls or []) if u]
    if not urls:
        return None
    return "|".join("[f=flv]{}".format(u) for u in urls)


def build_ffmpeg_stream_args(ffmpeg_path, destinations, framerate=30, video_bitrate_kbps=2500,
                              preset="veryfast", audio_bitrate_kbps=128, gop_frames=None):
    """Builds the ffmpeg argv that reads a continuous WebM stream on stdin
    (what the host's MediaRecorder chunks, relayed over Socket.IO, add up
    to) and re-encodes it ONCE to H.264/AAC, fanned out to every destination
    via the `tee` muxer -- one real-time encode shared by every destination,
    not N separate ffmpeg processes. `destinations` is a list of already-
    resolved push URLs (rtmp:// or a local file path for tests) -- or a bare
    string, treated as a single-element list. Returns None when there's
    nothing to push to."""
    if isinstance(destinations, str):
        destinations = [destinations]
    tee_spec = build_tee_destination_spec(destinations)
    if not tee_spec:
        return None
    gop = gop_frames or framerate * 2
    return [
        ffmpeg_path,
        # ffmpeg's stdin is occupied by the relayed WebM chunk stream, so it
        # can never answer an interactive "overwrite?" prompt -- harmless
        # for a real rtmp:// destination, but required for repeated local
        # file test runs.
        "-y",
        "-f", "webm",
        "-i", "pipe:0",
        # Required for the tee muxer -- without an explicit -map, tee fails
        # immediately even for a single multi-stream input.
        "-map", "0",
        "-c:v", "libx264",
        "-preset", preset,
        "-tune", "zerolatency",
        "-pix_fmt", "yuv420p",
        "-r", str(framerate),
        "-g", str(gop),
        "-b:v", "{}k".format(video_bitrate_kbps),
        "-maxrate", "{}k".format(video_bitrate_kbps),
        "-bufsize", "{}k".format(video_bitrate_kbps * 2),
        "-c:a", "aac",
        "-b:a", "{}k".format(audio_bitrate_kbps),
        "-ar", "44100",
        "-f", "tee",
        tee_spec,
    ]


def resolve_ffmpeg_path():
    """Prefers a real system ffmpeg install; falls back to the static
    binary bundled by the imageio-ffmpeg package (no system ffmpeg/Homebrew
    needed at all) -- see requirements.txt."""
    system_path = shutil.which("ffmpeg")
    if system_path:
        return system_path
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


# ---------------------------------------------------------------------
# Process lifecycle: one ffmpeg tee-fanout subprocess per live-session room,
# fed by continuous WebM chunks relayed from the host's browser.
# ---------------------------------------------------------------------

class _RoomRelay:
    """One running ffmpeg process for one room, with its stdin fed from a
    queue by a dedicated writer thread -- so a slow/blocked pipe (e.g. a
    destination with a bad connection) can never stall the caller (the
    Socket.IO event handler) that's enqueueing chunks."""

    def __init__(self, room_code, args):
        self.room_code = room_code
        self.args = args
        self.proc = None
        self._queue = queue.Queue()
        self._writer_thread = None
        self._stderr_thread = None
        self._stderr_tail = b""
        self._error = None

    def start(self):
        self.proc = subprocess.Popen(
            self.args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        self._writer_thread = threading.Thread(target=self._write_loop, daemon=True)
        self._writer_thread.start()
        self._stderr_thread = threading.Thread(target=self._read_stderr, daemon=True)
        self._stderr_thread.start()

    def enqueue(self, data):
        self._queue.put(data)

    def _write_loop(self):
        try:
            while True:
                chunk = self._queue.get()
                if chunk is None:  # stop sentinel
                    break
                try:
                    self.proc.stdin.write(chunk)
                    self.proc.stdin.flush()
                except (BrokenPipeError, OSError) as exc:
                    self._error = str(exc)
                    break
        finally:
            try:
                self.proc.stdin.close()
            except Exception:
                pass

    def _read_stderr(self):
        try:
            for line in iter(self.proc.stderr.readline, b""):
                self._stderr_tail = (self._stderr_tail + line)[-4000:]
        except Exception:
            pass
        finally:
            try:
                self.proc.stderr.close()
            except Exception:
                pass

    def is_alive(self):
        return self.proc is not None and self.proc.poll() is None

    def stop(self, timeout=5):
        self._queue.put(None)
        if self._writer_thread:
            self._writer_thread.join(timeout=timeout)
        if self.proc:
            try:
                self.proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    try:
                        self.proc.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        pass
        if self._stderr_thread:
            self._stderr_thread.join(timeout=2)

    def status(self):
        exit_code = self.proc.poll() if self.proc else None
        return {
            "active": self.is_alive(),
            "error": self._error,
            "exit_code": exit_code,
            "stderr_tail": self._stderr_tail.decode("utf-8", "ignore"),
        }


class BroadcastRelay:
    """Registry of _RoomRelay instances, keyed by room_code -- the thing
    app.py holds a single instance of for the whole process. Also the thing
    tests exercise end-to-end against real local RTMP listeners."""

    def __init__(self, ffmpeg_path=None, **ffmpeg_opts):
        self.ffmpeg_path = ffmpeg_path or resolve_ffmpeg_path()
        self.ffmpeg_opts = ffmpeg_opts
        self._lock = threading.Lock()
        self._rooms = {}

    def start(self, room_code, push_urls, **opts):
        with self._lock:
            existing = self._rooms.get(room_code)
            if existing and existing.is_alive():
                return {"ok": False, "error": "A broadcast is already running for this session."}
            merged_opts = dict(self.ffmpeg_opts)
            merged_opts.update(opts)
            args = build_ffmpeg_stream_args(self.ffmpeg_path, push_urls, **merged_opts)
            if not args:
                return {"ok": False, "error": "No enabled destination has a valid RTMP URL."}
            relay = _RoomRelay(room_code, args)
            relay.start()
            self._rooms[room_code] = relay
            return {"ok": True, "destinations": len(push_urls)}

    def write_chunk(self, room_code, data):
        relay = self._rooms.get(room_code)
        if relay and relay.is_alive():
            relay.enqueue(data)
            return True
        return False

    def is_active(self, room_code):
        relay = self._rooms.get(room_code)
        return bool(relay and relay.is_alive())

    def stop(self, room_code, timeout=5):
        with self._lock:
            relay = self._rooms.pop(room_code, None)
        if relay:
            relay.stop(timeout=timeout)
            return True
        return False

    def status(self, room_code):
        relay = self._rooms.get(room_code)
        if not relay:
            return {"active": False}
        return relay.status()

    def stop_all(self, timeout=5):
        """Stops every running relay -- registered with atexit in app.py so
        a server restart/shutdown never leaves an orphaned ffmpeg process
        still pushing to a platform."""
        with self._lock:
            rooms = list(self._rooms.items())
            self._rooms.clear()
        for _room_code, relay in rooms:
            relay.stop(timeout=timeout)
