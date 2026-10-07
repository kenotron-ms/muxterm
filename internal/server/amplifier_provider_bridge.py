"""Graphical provider setup against Amplifier's shared Foundation settings.

The host sends one JSON request on stdin. Never return credential values or
provider exception text: SDK exceptions can contain request headers.
"""

import json
import os
import re
import sys
from contextlib import redirect_stdout
from pathlib import Path

from amplifier_app_cli.key_manager import KeyManager
from amplifier_foundation.paths.resolution import get_amplifier_home
from amplifier_foundation.settings import read_settings, update_settings

class SetupError(ValueError):
    """Validation message safe to return to the browser."""


PROVIDERS = {
    "anthropic": ("ANTHROPIC_API_KEY", "provider-anthropic"),
    "openai": ("OPENAI_API_KEY", "provider-openai"),
    "gemini": ("GOOGLE_API_KEY", "provider-gemini"),
}


def rows():
    path = get_amplifier_home() / "settings.yaml"
    settings = read_settings((path,))
    configured = settings.get("config", {}).get("providers", [])
    if not isinstance(configured, list):
        raise SetupError("Amplifier provider settings are malformed")
    return configured


def state():
    configured = rows()
    inherited = {name: bool(os.environ.get(name)) for name, _ in PROVIDERS.values()}
    stored = KeyManager().stored_keys()
    output = []
    for identity, (env_name, module) in PROVIDERS.items():
        row = next((entry for entry in configured if isinstance(entry, dict) and
                    (entry.get("id") == identity or (not entry.get("id") and entry.get("module") == module))), None)
        source = "environment" if inherited[env_name] else "amplifier-keys" if env_name in stored else ""
        output.append({"id": identity, "source": source, "envName": env_name,
                       "configured": bool(row), "model": str((row or {}).get("config", {}).get("default_model", ""))})
    ordered = sorted((entry for entry in configured if isinstance(entry, dict)),
                     key=lambda entry: entry.get("config", {}).get("priority", 100))
    primary = (ordered[0].get("id") or ordered[0].get("module", "").removeprefix("provider-")) if ordered else ""
    return {"cliInstalled": True, "configured": bool(ordered), "primary": primary,
            "providers": output}


def save(request):
    identity = request.get("provider")
    if identity not in PROVIDERS:
        raise SetupError("Unsupported provider")
    env_name, module = PROVIDERS[identity]
    method = request.get("credentialSource")
    key = request.get("apiKey", "")
    explicit_env = bool(os.environ.get(env_name))
    KeyManager()  # Load Amplifier-managed keys before checking availability.
    if method not in ("environment", "private-key"):
        raise SetupError("Choose a credential source")
    if method == "private-key":
        if explicit_env:
            raise SetupError(f"{env_name} is already set in Muxterm's environment. Use that key or change the environment first")
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9._-]{8,16000}", key):
            raise SetupError("Enter a valid API key")
        KeyManager().save_key(env_name, key.strip())
        os.environ[env_name] = key.strip()
    elif key or not os.environ.get(env_name):
        raise SetupError(f"{env_name} is not available in Muxterm's environment")

    model = request.get("model", "")
    if not isinstance(model, str) or len(model) > 200 or (model and not re.fullmatch(r"[A-Za-z0-9_.:/-]+", model)):
        raise SetupError("Model name is invalid")

    def mutate(settings):
        config = settings.setdefault("config", {})
        providers = config.setdefault("providers", [])
        if not isinstance(providers, list):
            raise SetupError("Amplifier provider settings are malformed")
        existing = next((entry for entry in providers if isinstance(entry, dict) and
                         (entry.get("id") == identity or (not entry.get("id") and entry.get("module") == module))), None)
        if existing is None:
            existing = {"id": identity, "module": module, "config": {}}
            providers.append(existing)
        existing["id"] = identity
        existing["module"] = module
        values = existing.setdefault("config", {})
        values["api_key"] = "${" + env_name + "}"
        if model:
            values["default_model"] = model
        if request.get("makeDefault"):
            for entry in providers:
                if not isinstance(entry, dict):
                    continue
                old_priority = entry.get("config", {}).get("priority", 100)
                entry.setdefault("config", {})["priority"] = 1 if entry is existing else max(10, old_priority if isinstance(old_priority, int) else 100)
        elif "priority" not in values:
            values["priority"] = 1 if len(providers) == 1 else 100

    update_settings(get_amplifier_home() / "settings.yaml", mutate)
    return state()


def check(request):
    identity = request.get("provider")
    if identity not in PROVIDERS:
        raise SetupError("Unsupported provider")
    env_name, module = PROVIDERS[identity]
    configured = next((entry for entry in rows() if isinstance(entry, dict) and
                       (entry.get("id") == identity or (not entry.get("id") and entry.get("module") == module))), None)
    if configured is None:
        raise SetupError("Save this provider first")
    KeyManager()  # Loads private keys into this short-lived process.
    if not os.environ.get(env_name):
        raise SetupError(f"{env_name} is unavailable")
    from amplifier_app_cli.provider_sources import ensure_provider_installed, is_provider_module_installed
    if not is_provider_module_installed(module) and not ensure_provider_installed(module):
        raise SetupError("Amplifier could not install this provider module")
    from amplifier_app_cli.provider_loader import get_provider_models
    models = get_provider_models(module, collected_config={"api_key": os.environ[env_name]})
    if not models:
        raise SetupError("The provider returned no available models")
    return {"ok": True, "modelCount": len(models)}


def main():
    request = json.load(sys.stdin)
    action = request.get("action")
    with redirect_stdout(sys.stderr):
        if action == "status":
            result = state()
        elif action == "save":
            result = save(request)
        elif action == "check":
            result = check(request)
        else:
            raise SetupError("Unsupported action")
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except SetupError as exc:
        print(json.dumps({"error": str(exc)}))
    except Exception as exc:
        kind = type(exc).__name__.lower()
        if "auth" in kind or "permission" in kind or "invalidkey" in kind:
            message = "The provider rejected this credential. Check the API key and try again."
        elif "ratelimit" in kind:
            message = "The provider rate limited this check. Try again later."
        elif "connect" in kind or "timeout" in kind:
            message = "Could not reach the provider. Check the network and try again."
        elif "import" in kind or "module" in kind:
            message = "Amplifier could not load this provider module. Retry its installation."
        else:
            message = "Amplifier could not complete this provider action. Check its installation and retry."
        print(json.dumps({"error": message}))
