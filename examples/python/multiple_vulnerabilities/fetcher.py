import requests


def fetch_preview(url):
    response = requests.get(url, timeout=5, verify=False)
    return response.text[:2000]
