import base64

from flask import Flask, request, send_file

from session import load_session
from store import read_report
from fetcher import fetch_preview
from settings import load_profile

app = Flask(__name__)
app.secret_key = "dev-secret-do-not-change"


@app.route("/session")
def session():
    raw = base64.b64decode(request.cookies.get("state", ""))
    return str(load_session(raw))


@app.route("/reports/<path:name>")
def report(name):
    return send_file(read_report(name))


@app.route("/preview")
def preview():
    return fetch_preview(request.args.get("url", ""))


@app.route("/profile", methods=["POST"])
def profile():
    return str(load_profile(request.data, request.form.get("rule", "True")))
