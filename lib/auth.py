import os
import secrets
from functools import wraps

from flask import session, redirect, url_for, request
from werkzeug.security import generate_password_hash, check_password_hash

from . import db

CREDENTIALS_NOTICE_PATH = os.path.join(db.DATA_DIR, "ADMIN_CREDENTIALS.txt")


def bootstrap_admin():
    with db.session() as conn:
        existing = conn.execute("SELECT id FROM admin_users LIMIT 1").fetchone()
        if existing:
            return
        password = secrets.token_urlsafe(9)
        conn.execute(
            "INSERT INTO admin_users (username, password_hash) VALUES (?,?)",
            ("admin", generate_password_hash(password, method="pbkdf2:sha256")),
        )
    with open(CREDENTIALS_NOTICE_PATH, "w") as f:
        f.write(
            "Msanii Media admin — first-run credentials\n"
            "===========================================\n"
            "Username: admin\n"
            "Password: {}\n\n"
            "Log in at /admin/login, then change your password from Settings.\n".format(password)
        )


def verify_login(username, password):
    with db.session() as conn:
        row = conn.execute("SELECT * FROM admin_users WHERE username = ?", (username,)).fetchone()
    if row and check_password_hash(row["password_hash"], password):
        return row
    return None


def set_password(user_id, new_password):
    with db.session() as conn:
        conn.execute(
            "UPDATE admin_users SET password_hash = ? WHERE id = ?",
            (generate_password_hash(new_password, method="pbkdf2:sha256"), user_id),
        )


def get_csrf_token():
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_hex(16)
    return session["csrf_token"]


def verify_csrf(token):
    expected = session.get("csrf_token")
    return bool(token) and bool(expected) and secrets.compare_digest(token, expected)


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("admin_id"):
            return redirect(url_for("admin_login", next=request.path))
        return view(*args, **kwargs)

    return wrapped


def api_login_required(view):
    """Like login_required, but for JSON endpoints -- returns 401 instead of
    redirecting to the login page, since a fetch()/PATCH caller has no use
    for an HTML redirect response."""
    from flask import jsonify

    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("admin_id"):
            return jsonify({"error": "unauthorized"}), 401
        return view(*args, **kwargs)

    return wrapped
