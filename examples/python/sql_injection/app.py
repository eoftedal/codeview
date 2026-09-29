from flask import Flask, jsonify, request

from repository import find_users, user_by_id

app = Flask(__name__)


@app.route("/users")
def users():
    name = request.args.get("name", "")
    return jsonify(find_users(name))


@app.route("/users/<user_id>")
def one_user(user_id):
    return jsonify(user_by_id(user_id))
