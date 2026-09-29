import sqlite3


class Lookup:
    def __init__(self, term):
        self.term = term

    def where(self):
        return "name LIKE '%%%s%%'" % self.term


def connect():
    return sqlite3.connect("app.db")


def find_users(name):
    return run(Lookup(name))


def run(lookup):
    cur = connect().cursor()
    cur.execute("SELECT id, email FROM users WHERE " + lookup.where())
    return cur.fetchall()


def user_by_id(user_id):
    cur = connect().cursor()
    cur.execute(f"SELECT id, email FROM users WHERE id = {user_id}")
    return cur.fetchone()


def fetch_user(user_id):
    cur = connect().cursor()
    cur.execute("SELECT id, email FROM users WHERE id = ?", (user_id,))
    return cur.fetchone()
