import yaml


def load_profile(document, rule):
    profile = yaml.load(document, Loader=yaml.Loader)
    if eval(rule):
        profile["checked"] = True
    return profile
