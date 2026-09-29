import os
import subprocess


class Probe:
    def __init__(self, host):
        self.host = host
        self.count = 1

    def command(self):
        return "ping -c %d %s" % (self.count, self.host)

    def run(self):
        return subprocess.check_output(self.command(), shell=True).decode()


def tail_log(name):
    return os.system(f"tail -n 100 /var/log/app/{name}")


def reach(host):
    return subprocess.check_output(["ping", "-c", "1", host]).decode()
