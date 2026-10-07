import requests


def loaded_model(url: str) -> tuple[bool, str | None]:
    """(reachable, repo id of the served model) from the vLLM server behind a chat completions URL."""
    root = url.removesuffix("/chat/completions")
    try:
        response = requests.get(f"{root}/models", timeout=15)
        response.raise_for_status()
        data = response.json()["data"]
    except (requests.RequestException, ValueError, KeyError):
        return False, None
    return True, data[0]["id"] if data else None
