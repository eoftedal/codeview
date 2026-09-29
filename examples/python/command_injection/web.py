from flask import Flask, request

from netops import Probe, tail_log

app = Flask(__name__)


@app.route("/ping")
def ping():
    host = request.args.get("host", "localhost")
    return Probe(host).run()


@app.route("/logs")
def logs():
    return tail_log(request.headers.get("X-Log-Name", "app.log"))
