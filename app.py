import os
import secrets

from flask import Flask, render_template, request, redirect, url_for, session, flash, abort, jsonify
from flask_socketio import SocketIO, join_room, emit
from werkzeug.utils import secure_filename

from lib import db, auth, content

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 300 * 1024 * 1024  # 300MB, generous for a recorded live clip

UPLOAD_ROOT = os.path.join(db.DATA_DIR, "uploads")


def _get_or_create_secret_key():
    path = os.path.join(db.DATA_DIR, "secret_key.txt")
    if os.path.exists(path):
        with open(path) as f:
            return f.read().strip()
    key = secrets.token_hex(32)
    with open(path, "w") as f:
        f.write(key)
    return key


app.secret_key = _get_or_create_secret_key()
db.init_db()
auth.bootstrap_admin()
socketio = SocketIO(app, async_mode="gevent", max_http_buffer_size=300 * 1024 * 1024)


@app.context_processor
def inject_globals():
    return dict(csrf_token=auth.get_csrf_token, site_name="Msanii Media")


@app.before_request
def csrf_protect():
    protected = (
        request.method == "POST"
        and request.path.startswith("/admin")
        and request.path != "/admin/login"
    )
    if protected:
        token = request.form.get("csrf_token")
        if not auth.verify_csrf(token):
            abort(400, description="Invalid or missing security token. Please refresh the page and try again.")


def save_upload(file_storage, subdir):
    if not file_storage or not file_storage.filename:
        return ""
    filename = secure_filename(file_storage.filename)
    unique = "{}-{}".format(secrets.token_hex(6), filename)
    dest_dir = os.path.join(UPLOAD_ROOT, subdir)
    os.makedirs(dest_dir, exist_ok=True)
    dest_path = os.path.join(dest_dir, unique)
    file_storage.save(dest_path)
    return "/uploads/{}/{}".format(subdir, unique)


@app.route("/uploads/<subdir>/<filename>")
def serve_upload(subdir, filename):
    from flask import send_from_directory
    return send_from_directory(os.path.join(UPLOAD_ROOT, subdir), filename)


# ==================================================================
# Public site
# ==================================================================

@app.route("/")
def home():
    live_now = content.list_live_sessions(status="live")
    episodes = content.list_episodes()[:6]
    news = content.list_news()[:3]
    ads = content.list_ads(placement="homepage")
    return render_template("public/home.html", live_now=live_now, episodes=episodes, news=news, ads=ads)


@app.route("/shows")
def shows_list():
    series = content.list_shows(kind="series")
    talk_shows = content.list_shows(kind="talk_show")
    return render_template("public/shows.html", series=series, talk_shows=talk_shows)


@app.route("/shows/<int:show_id>")
def show_detail(show_id):
    show = content.get_show(show_id)
    if not show or not show["active"]:
        abort(404)
    episodes = content.list_episodes(show_id=show_id)
    return render_template("public/show_detail.html", show=show, episodes=episodes)


@app.route("/episodes/<int:episode_id>")
def episode_detail(episode_id):
    episode = content.get_episode(episode_id)
    if not episode or not episode["active"]:
        abort(404)
    ads = content.list_ads(placement="episode")
    return render_template("public/episode_detail.html", episode=episode, ads=ads)


@app.route("/news")
def news_list():
    posts = content.list_news()
    return render_template("public/news_list.html", posts=posts)


@app.route("/news/<int:post_id>")
def news_detail(post_id):
    post = content.get_news(post_id)
    if not post or not post["active"]:
        abort(404)
    ads = content.list_ads(placement="news")
    return render_template("public/news_detail.html", post=post, ads=ads)


@app.route("/ads")
def ads_list():
    ads = content.list_ads()
    return render_template("public/ads.html", ads=ads)


@app.route("/live")
def live_list():
    live_now = content.list_live_sessions(status="live")
    scheduled = content.list_live_sessions(status="scheduled")
    ended = [s for s in content.list_live_sessions(status="ended") if s["recording_path"]]
    return render_template("public/live_list.html", live_now=live_now, scheduled=scheduled, ended=ended)


@app.route("/live/status.json")
def live_status_json():
    """Lightweight polling endpoint so the /live listing page can reflect a
    session moving between scheduled/live/ended without a manual reload."""
    sessions = content.list_live_sessions()
    return jsonify({
        "sessions": [
            {
                "id": s["id"],
                "room_code": s["room_code"],
                "title": s["title"],
                "host_name": s["host_name"],
                "status": s["status"],
                "has_recording": bool(s["recording_path"]),
            }
            for s in sessions
        ]
    })


@app.route("/live/<room_code>/replay")
def live_replay(room_code):
    live_session = content.get_live_session_by_room(room_code)
    if not live_session or not live_session["recording_path"]:
        abort(404)
    return render_template("public/live_replay.html", live_session=live_session)


@app.route("/live/<room_code>")
def live_room(room_code):
    live_session = content.get_live_session_by_room(room_code)
    if not live_session:
        abort(404)
    return render_template("public/live_room.html", live_session=live_session)


@app.route("/live/<room_code>/host")
def live_host(room_code):
    live_session = content.get_live_session_by_room(room_code)
    if not live_session:
        abort(404)
    return render_template("public/live_host.html", live_session=live_session)


@app.route("/live/<room_code>/upload-recording", methods=["POST"])
def upload_recording(room_code):
    live_session = content.get_live_session_by_room(room_code)
    if not live_session:
        abort(404)
    file = request.files.get("recording")
    if not file:
        return jsonify({"ok": False, "error": "no file"}), 400
    path = save_upload(file, "recordings")
    content.set_live_recording(live_session["id"], path)
    return jsonify({"ok": True, "path": path})


# ==================================================================
# Admin auth
# ==================================================================

@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    if request.method == "POST":
        username = request.form.get("username", "")
        password = request.form.get("password", "")
        user = auth.verify_login(username, password)
        if user:
            session.clear()
            session["admin_id"] = user["id"]
            session["admin_username"] = user["username"]
            next_url = request.args.get("next") or url_for("admin_dashboard")
            return redirect(next_url, code=303)
        flash("Invalid username or password.", "error")
    return render_template("admin/login.html")


@app.route("/admin/logout")
def admin_logout():
    session.clear()
    return redirect(url_for("admin_login"))


@app.route("/admin")
@auth.login_required
def admin_dashboard():
    stats = {
        "shows": len(content.list_shows(include_inactive=True)),
        "episodes": len(content.list_episodes(include_inactive=True)),
        "news": len(content.list_news(include_inactive=True)),
        "ads": len(content.list_ads(include_inactive=True)),
        "live_sessions": len(content.list_live_sessions()),
    }
    return render_template("admin/dashboard.html", stats=stats)


@app.route("/admin/settings", methods=["GET", "POST"])
@auth.login_required
def admin_settings():
    if request.method == "POST":
        current = request.form.get("current_password", "")
        new = request.form.get("new_password", "")
        confirm = request.form.get("confirm_password", "")
        if not auth.verify_login(session.get("admin_username", ""), current):
            flash("Current password is incorrect.", "error")
        elif len(new) < 8:
            flash("New password must be at least 8 characters.", "error")
        elif new != confirm:
            flash("New password and confirmation don't match.", "error")
        else:
            auth.set_password(session["admin_id"], new)
            flash("Password updated.", "success")
        return redirect(url_for("admin_settings"), code=303)
    return render_template("admin/settings.html")


# ==================================================================
# Admin: Shows & Episodes
# ==================================================================

@app.route("/admin/shows", methods=["GET", "POST"])
@auth.login_required
def admin_shows():
    if request.method == "POST":
        title = request.form.get("title", "").strip()
        if not title:
            flash("Show title is required.", "error")
        else:
            cover = save_upload(request.files.get("cover_image"), "thumbnails")
            content.create_show(title, request.form.get("kind", "series"), request.form.get("description", "").strip(), cover)
            flash("Show created.", "success")
        return redirect(url_for("admin_shows"), code=303)
    shows = content.list_shows(include_inactive=True)
    return render_template("admin/shows.html", shows=shows)


@app.route("/admin/shows/<int:show_id>/toggle", methods=["POST"])
@auth.login_required
def admin_show_toggle(show_id):
    show = content.get_show(show_id)
    if not show:
        abort(404)
    content.set_show_active(show_id, not show["active"])
    return redirect(url_for("admin_shows"), code=303)


@app.route("/admin/shows/<int:show_id>/episodes", methods=["GET", "POST"])
@auth.login_required
def admin_episodes(show_id):
    show = content.get_show(show_id)
    if not show:
        abort(404)
    if request.method == "POST":
        title = request.form.get("title", "").strip()
        if not title:
            flash("Episode title is required.", "error")
        else:
            thumb = save_upload(request.files.get("thumbnail"), "thumbnails")
            content.create_episode(
                show_id, title, request.form.get("description", "").strip(),
                int(request.form.get("episode_number") or 1),
                request.form.get("video_url", "").strip(), thumb,
                request.form.get("published_at", "").strip(),
            )
            flash("Episode added.", "success")
        return redirect(url_for("admin_episodes", show_id=show_id), code=303)
    episodes = content.list_episodes(show_id=show_id, include_inactive=True)
    return render_template("admin/episodes.html", show=show, episodes=episodes)


@app.route("/admin/episodes/<int:episode_id>/toggle", methods=["POST"])
@auth.login_required
def admin_episode_toggle(episode_id):
    episode = content.get_episode(episode_id)
    if not episode:
        abort(404)
    content.set_episode_active(episode_id, not episode["active"])
    return redirect(url_for("admin_episodes", show_id=episode["show_id"]), code=303)


@app.patch("/api/episodes/<int:episode_id>")
@auth.api_login_required
def api_edit_episode(episode_id):
    episode = content.get_episode(episode_id)
    if not episode:
        return jsonify({"error": "Episode not found."}), 404
    data = request.get_json(silent=True) or {}
    updates = {}
    for key in ("title", "description", "video_url"):
        if key in data:
            value = (data.get(key) or "").strip()
            if not value:
                return jsonify({"error": "{} cannot be empty.".format(key)}), 400
            updates[key] = value
    if not updates:
        return jsonify({"error": "Nothing to update."}), 400
    content.update_episode(episode_id, **updates)
    return jsonify({"ok": True})


# ==================================================================
# Admin: News
# ==================================================================

@app.route("/admin/news", methods=["GET", "POST"])
@auth.login_required
def admin_news():
    if request.method == "POST":
        title = request.form.get("title", "").strip()
        if not title:
            flash("News title is required.", "error")
        else:
            image = save_upload(request.files.get("image"), "thumbnails")
            content.create_news(
                title, request.form.get("body", "").strip(), image,
                request.form.get("author", "").strip(), request.form.get("published_at", "").strip(),
            )
            flash("News post published.", "success")
        return redirect(url_for("admin_news"), code=303)
    posts = content.list_news(include_inactive=True)
    return render_template("admin/news.html", posts=posts)


@app.route("/admin/news/<int:post_id>/toggle", methods=["POST"])
@auth.login_required
def admin_news_toggle(post_id):
    post = content.get_news(post_id)
    if not post:
        abort(404)
    content.set_news_active(post_id, not post["active"])
    return redirect(url_for("admin_news"), code=303)


# ==================================================================
# Admin: Ads
# ==================================================================

@app.route("/admin/ads", methods=["GET", "POST"])
@auth.login_required
def admin_ads():
    if request.method == "POST":
        title = request.form.get("title", "").strip()
        if not title:
            flash("Ad title is required.", "error")
        else:
            creative = save_upload(request.files.get("creative_image"), "ads")
            content.create_ad(
                title, request.form.get("sponsor", "").strip(), creative,
                request.form.get("link_url", "").strip(), request.form.get("placement", "homepage"),
            )
            flash("Ad created.", "success")
        return redirect(url_for("admin_ads"), code=303)
    ads = content.list_ads(include_inactive=True)
    return render_template("admin/ads.html", ads=ads)


@app.route("/admin/ads/<int:ad_id>/toggle", methods=["POST"])
@auth.login_required
def admin_ad_toggle(ad_id):
    ad = content.get_ad(ad_id)
    if not ad:
        abort(404)
    content.set_ad_active(ad_id, not ad["active"])
    return redirect(url_for("admin_ads"), code=303)


# ==================================================================
# Admin: Live sessions
# ==================================================================

@app.route("/admin/live", methods=["GET", "POST"])
@auth.login_required
def admin_live():
    if request.method == "POST":
        title = request.form.get("title", "").strip()
        host_name = request.form.get("host_name", "").strip()
        if not title:
            flash("Session title is required.", "error")
        else:
            session_id, room_code = content.create_live_session(title, host_name)
            flash("Live session created — share the viewer link, and use the host link to go live.", "success")
            return redirect(url_for("admin_live"), code=303)
        return redirect(url_for("admin_live"), code=303)
    sessions_ = content.list_live_sessions()
    return render_template("admin/live.html", sessions=sessions_)


@app.patch("/api/live/<int:session_id>")
@auth.api_login_required
def api_edit_live(session_id):
    live_session = content.get_live_session(session_id)
    if not live_session:
        return jsonify({"error": "Live session not found."}), 404
    data = request.get_json(silent=True) or {}
    title = data.get("title")
    host_name = data.get("host_name")
    if title is not None:
        title = title.strip()
        if not title:
            return jsonify({"error": "Session title is required."}), 400
    if host_name is not None:
        host_name = host_name.strip()
    content.update_live_session(session_id, title=title, host_name=host_name)
    return jsonify({"ok": True})


@app.delete("/api/live/<int:session_id>")
@auth.api_login_required
def api_delete_live(session_id):
    live_session = content.get_live_session(session_id)
    if not live_session:
        return jsonify({"error": "Live session not found."}), 404
    # A saved recording's file lives under uploads/recordings and is unique to
    # this session (never shared/referenced elsewhere) -- safe to remove from
    # disk unconditionally once the session row referencing it is gone.
    recording_path = live_session["recording_path"]
    if recording_path and recording_path.startswith("/uploads/recordings/"):
        filename = recording_path.rsplit("/", 1)[-1]
        path = os.path.join(UPLOAD_ROOT, "recordings", filename)
        try:
            if os.path.isfile(path):
                os.remove(path)
        except OSError:
            pass
    content.delete_live_session(session_id)
    return jsonify({"ok": True})


# ==================================================================
# Socket.IO — live chat, WebRTC signaling relay, camera-join workflow
# ==================================================================

@socketio.on("join_room")
def on_join_room(data):
    room_code = data.get("room")
    role = data.get("role", "viewer")  # 'host' | 'viewer'
    name = data.get("name", "Guest")
    if not room_code:
        return
    join_room(room_code)
    live_session = content.get_live_session_by_room(room_code)
    if live_session:
        history = [dict(m) for m in content.list_chat_messages(live_session["id"])]
        emit("chat_history", {"messages": history})
    emit("presence", {"role": role, "name": name, "sid": request.sid}, to=room_code, include_self=False)


@socketio.on("chat_message")
def on_chat_message(data):
    room_code = data.get("room")
    name = data.get("name", "Guest")
    message = (data.get("message") or "").strip()
    if not room_code or not message:
        return
    live_session = content.get_live_session_by_room(room_code)
    if not live_session:
        return
    content.add_chat_message(live_session["id"], name, message)
    emit("chat_message", {"name": name, "message": message}, to=room_code)


@socketio.on("host_go_live")
def on_host_go_live(data):
    room_code = data.get("room")
    live_session = content.get_live_session_by_room(room_code)
    if not live_session:
        return
    content.set_live_status(live_session["id"], "live")
    emit("live_status", {"status": "live"}, to=room_code)


@socketio.on("host_end_live")
def on_host_end_live(data):
    room_code = data.get("room")
    live_session = content.get_live_session_by_room(room_code)
    if not live_session:
        return
    content.set_live_status(live_session["id"], "ended")
    emit("live_status", {"status": "ended"}, to=room_code)


@socketio.on("camera_offer")
def on_camera_offer(data):
    # Viewer sends its WebRTC offer up front (not after approval) so the host
    # can preview their live camera/mic before deciding -- this event carries
    # both the join request and the SDP that used to arrive separately, later,
    # only once approved.
    room_code = data.get("room")
    name = data.get("name", "Guest")
    sdp = data.get("sdp")
    if not sdp:
        return
    live_session = content.get_live_session_by_room(room_code)
    if not live_session:
        return
    req_id = content.create_camera_request(live_session["id"], name, request.sid)
    emit(
        "camera_offer",
        {"request_id": req_id, "name": name, "sdp": sdp, "socket_id": request.sid},
        to=room_code,
        include_self=False,
    )


@socketio.on("respond_camera")
def on_respond_camera(data):
    room_code = data.get("room")
    request_id = data.get("request_id")
    approve = bool(data.get("approve"))
    req = content.get_camera_request(request_id)
    if not req:
        return
    content.set_camera_request_status(request_id, "approved" if approve else "denied")
    emit(
        "camera_response",
        {"request_id": request_id, "approve": approve, "host_sid": request.sid},
        to=req["socket_id"],
    )
    if approve:
        emit("guest_joining", {"socket_id": req["socket_id"], "name": req["viewer_name"]}, to=room_code)


# ---- WebRTC signaling relay (direct socket-to-socket, not room broadcast) ----

@socketio.on("webrtc_signal")
def on_webrtc_signal(data):
    target_sid = data.get("to")
    if not target_sid:
        return
    payload = dict(data)
    payload["from"] = request.sid
    emit("webrtc_signal", payload, to=target_sid)


if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=6060, debug=True, allow_unsafe_werkzeug=True)
