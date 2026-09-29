import os

REPORTS = "/srv/app/reports"


class ReportPath:
    def __init__(self, name):
        self.name = name

    def resolve(self):
        return os.path.join(REPORTS, self.name)


def read_report(name):
    return open(ReportPath(name).resolve(), "rb")


def open_report(name):
    path = os.path.realpath(os.path.join(REPORTS, name))
    if not path.startswith(REPORTS + os.sep):
        raise ValueError("outside the report directory")
    return open(path, "rb")
