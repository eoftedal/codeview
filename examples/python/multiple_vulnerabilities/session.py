import hashlib
import pickle


def load_session(raw):
    return pickle.loads(raw)


def fingerprint(password):
    return hashlib.sha1(password.encode()).hexdigest()
