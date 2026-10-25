import datetime
import secrets

from . import db


def now_str():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M")


# ---------------- Shows & Episodes ----------------

def list_shows(kind=None, include_inactive=False):
    with db.session() as conn:
        q = "SELECT * FROM shows WHERE 1=1"
        params = []
        if kind:
            q += " AND kind = ?"
            params.append(kind)
        if not include_inactive:
            q += " AND active = 1"
        q += " ORDER BY created_at DESC"
        return conn.execute(q, params).fetchall()


def get_show(show_id):
    with db.session() as conn:
        return conn.execute("SELECT * FROM shows WHERE id = ?", (show_id,)).fetchone()


def create_show(title, kind, description, cover_image=""):
    with db.session() as conn:
        cur = conn.execute(
            "INSERT INTO shows (title, kind, description, cover_image) VALUES (?,?,?,?)",
            (title, kind, description, cover_image),
        )
        return cur.lastrowid


def set_show_active(show_id, active):
    with db.session() as conn:
        conn.execute("UPDATE shows SET active = ? WHERE id = ?", (1 if active else 0, show_id))


def list_episodes(show_id=None, include_inactive=False):
    with db.session() as conn:
        q = """SELECT e.*, s.title AS show_title, s.kind AS show_kind FROM episodes e
               JOIN shows s ON s.id = e.show_id WHERE 1=1"""
        params = []
        if show_id:
            q += " AND e.show_id = ?"
            params.append(show_id)
        if not include_inactive:
            q += " AND e.active = 1"
        q += " ORDER BY e.published_at DESC"
        return conn.execute(q, params).fetchall()


def get_episode(episode_id):
    with db.session() as conn:
        return conn.execute(
            """SELECT e.*, s.title AS show_title, s.kind AS show_kind FROM episodes e
               JOIN shows s ON s.id = e.show_id WHERE e.id = ?""",
            (episode_id,),
        ).fetchone()


def create_episode(show_id, title, description, episode_number, video_url, thumbnail, published_at):
    with db.session() as conn:
        cur = conn.execute(
            """INSERT INTO episodes (show_id, title, description, episode_number, video_url, thumbnail, published_at)
               VALUES (?,?,?,?,?,?,?)""",
            (show_id, title, description, episode_number, video_url, thumbnail, published_at or now_str()),
        )
        return cur.lastrowid


def set_episode_active(episode_id, active):
    with db.session() as conn:
        conn.execute("UPDATE episodes SET active = ? WHERE id = ?", (1 if active else 0, episode_id))


def update_episode(episode_id, title=None, description=None, video_url=None):
    with db.session() as conn:
        if title is not None:
            conn.execute("UPDATE episodes SET title = ? WHERE id = ?", (title, episode_id))
        if description is not None:
            conn.execute("UPDATE episodes SET description = ? WHERE id = ?", (description, episode_id))
        if video_url is not None:
            conn.execute("UPDATE episodes SET video_url = ? WHERE id = ?", (video_url, episode_id))


# ---------------- News ----------------

def list_news(include_inactive=False):
    with db.session() as conn:
        q = "SELECT * FROM news_posts"
        if not include_inactive:
            q += " WHERE active = 1"
        q += " ORDER BY published_at DESC"
        return conn.execute(q).fetchall()


def get_news(post_id):
    with db.session() as conn:
        return conn.execute("SELECT * FROM news_posts WHERE id = ?", (post_id,)).fetchone()


def create_news(title, body, image, author, published_at):
    with db.session() as conn:
        cur = conn.execute(
            "INSERT INTO news_posts (title, body, image, author, published_at) VALUES (?,?,?,?,?)",
            (title, body, image, author, published_at or now_str()),
        )
        return cur.lastrowid


def set_news_active(post_id, active):
    with db.session() as conn:
        conn.execute("UPDATE news_posts SET active = ? WHERE id = ?", (1 if active else 0, post_id))


# ---------------- Ads ----------------

def list_ads(placement=None, include_inactive=False):
    with db.session() as conn:
        q = "SELECT * FROM ads WHERE 1=1"
        params = []
        if placement:
            q += " AND placement = ?"
            params.append(placement)
        if not include_inactive:
            q += " AND active = 1"
        q += " ORDER BY created_at DESC"
        return conn.execute(q, params).fetchall()


def get_ad(ad_id):
    with db.session() as conn:
        return conn.execute("SELECT * FROM ads WHERE id = ?", (ad_id,)).fetchone()


def create_ad(title, sponsor, creative_image, link_url, placement):
    with db.session() as conn:
        cur = conn.execute(
            "INSERT INTO ads (title, sponsor, creative_image, link_url, placement) VALUES (?,?,?,?,?)",
            (title, sponsor, creative_image, link_url, placement),
        )
        return cur.lastrowid


def set_ad_active(ad_id, active):
    with db.session() as conn:
        conn.execute("UPDATE ads SET active = ? WHERE id = ?", (1 if active else 0, ad_id))


# ---------------- Live sessions ----------------

def create_live_session(title, host_name):
    room_code = secrets.token_urlsafe(6).replace("_", "").replace("-", "")[:8]
    with db.session() as conn:
        cur = conn.execute(
            "INSERT INTO live_sessions (title, host_name, room_code) VALUES (?,?,?)",
            (title, host_name, room_code),
        )
        return cur.lastrowid, room_code


def get_live_session(session_id):
    with db.session() as conn:
        return conn.execute("SELECT * FROM live_sessions WHERE id = ?", (session_id,)).fetchone()


def get_live_session_by_room(room_code):
    with db.session() as conn:
        return conn.execute("SELECT * FROM live_sessions WHERE room_code = ?", (room_code,)).fetchone()


def list_live_sessions(status=None):
    with db.session() as conn:
        q = "SELECT * FROM live_sessions"
        params = []
        if status:
            q += " WHERE status = ?"
            params.append(status)
        q += " ORDER BY created_at DESC"
        return conn.execute(q, params).fetchall()


def set_live_status(session_id, status):
    with db.session() as conn:
        if status == "live":
            conn.execute(
                "UPDATE live_sessions SET status = ?, started_at = datetime('now') WHERE id = ?",
                (status, session_id),
            )
        elif status == "ended":
            conn.execute(
                "UPDATE live_sessions SET status = ?, ended_at = datetime('now') WHERE id = ?",
                (status, session_id),
            )
        else:
            conn.execute("UPDATE live_sessions SET status = ? WHERE id = ?", (status, session_id))


def set_live_recording(session_id, recording_path):
    with db.session() as conn:
        conn.execute("UPDATE live_sessions SET recording_path = ? WHERE id = ?", (recording_path, session_id))


def update_live_session(session_id, title=None, host_name=None):
    with db.session() as conn:
        if title is not None:
            conn.execute("UPDATE live_sessions SET title = ? WHERE id = ?", (title, session_id))
        if host_name is not None:
            conn.execute("UPDATE live_sessions SET host_name = ? WHERE id = ?", (host_name, session_id))


def delete_live_session(session_id):
    with db.session() as conn:
        conn.execute("DELETE FROM chat_messages WHERE live_session_id = ?", (session_id,))
        conn.execute("DELETE FROM camera_requests WHERE live_session_id = ?", (session_id,))
        conn.execute("DELETE FROM live_sessions WHERE id = ?", (session_id,))


def add_chat_message(session_id, sender_name, message):
    with db.session() as conn:
        cur = conn.execute(
            "INSERT INTO chat_messages (live_session_id, sender_name, message) VALUES (?,?,?)",
            (session_id, sender_name, message),
        )
        return cur.lastrowid


def list_chat_messages(session_id):
    with db.session() as conn:
        return conn.execute(
            "SELECT * FROM chat_messages WHERE live_session_id = ? ORDER BY id ASC", (session_id,)
        ).fetchall()


def create_camera_request(session_id, viewer_name, socket_id):
    with db.session() as conn:
        cur = conn.execute(
            "INSERT INTO camera_requests (live_session_id, viewer_name, socket_id) VALUES (?,?,?)",
            (session_id, viewer_name, socket_id),
        )
        return cur.lastrowid


def set_camera_request_status(request_id, status):
    with db.session() as conn:
        conn.execute("UPDATE camera_requests SET status = ? WHERE id = ?", (status, request_id))


def get_camera_request(request_id):
    with db.session() as conn:
        return conn.execute("SELECT * FROM camera_requests WHERE id = ?", (request_id,)).fetchone()


def list_pending_camera_requests(session_id):
    with db.session() as conn:
        return conn.execute(
            "SELECT * FROM camera_requests WHERE live_session_id = ? AND status = 'pending' ORDER BY requested_at",
            (session_id,),
        ).fetchall()
