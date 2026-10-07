"""Graphical provider setup against Amplifier's shared Foundation settings.

The host sends one JSON request on stdin. Never return credential values or
provider exception text: SDK exceptions can contain request headers.
"""

import json
import importlib.util
import os
import re
import sys
import shutil
import subprocess
from contextlib import redirect_stdout
from pathlib import Path

# Amplifier imports may load keys.env into os.environ. Capture what the app
# actually inherited first so the UI can name the credential source correctly
# and a stored key can be replaced without treating it as an external override.
ENV_NAMES = {
    "anthropic": ("ANTHROPIC_API_KEY",),
    "openai": ("OPENAI_API_KEY",),
    "gemini": ("GOOGLE_API_KEY", "GEMINI_API_KEY"),
    "github-copilot": ("GITHUB_TOKEN", "COPILOT_AGENT_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_TOKEN"),
}
EXPLICIT_CREDENTIALS = {name: bool(os.environ.get(name)) for names in ENV_NAMES.values() for name in names}

from amplifier_app_cli.key_manager import KeyManager
from amplifier_foundation.paths.resolution import get_amplifier_home

class SetupError(ValueError):
    """Validation message safe to return to the browser."""


PROVIDERS = {
    "anthropic": "provider-anthropic",
    "openai": "provider-openai",
    "gemini": "provider-gemini",
    "github-copilot": "provider-github-copilot",
}


def row_id(entry):
    return entry.get("id") or entry.get("instance_id") or str(entry.get("module", "")).removeprefix("provider-")


def ordered_rows(configured):
    return sorted((entry for entry in configured if isinstance(entry, dict)),
                  key=lambda entry: entry.get("config", {}).get("priority", 100))


def github_cli_token():
    binary = shutil.which("gh")
    if not binary:
        return None
    try:
        result = subprocess.run([binary, "auth", "token", "--hostname", "github.com"],
                                capture_output=True, text=True, timeout=4, check=False)
        token = result.stdout.strip()
        return token if result.returncode == 0 and token and len(token) < 16000 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def credential_name(identity, row=None):
    field = "github_token" if identity == "github-copilot" else "api_key"
    value = (row or {}).get("config", {}).get(field, "")
    reference = re.fullmatch(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", value) if isinstance(value, str) else None
    if reference:
        return reference.group(1)
    return next((name for name in ENV_NAMES[identity] if os.environ.get(name)), ENV_NAMES[identity][0])


def rows():
    from amplifier_foundation.settings import read_settings
    path = get_amplifier_home() / "settings.yaml"
    settings = read_settings((path,))
    configured = settings.get("config", {}).get("providers", [])
    if not isinstance(configured, list):
        raise SetupError("Amplifier provider settings are malformed")
    return configured


def state():
    supported = importlib.util.find_spec("amplifier_foundation.settings") is not None
    configured = rows() if supported else []
    stored = KeyManager().stored_keys()
    output = []
    for identity, module in PROVIDERS.items():
        row = next((entry for entry in configured if isinstance(entry, dict) and
                    (row_id(entry) == identity or (not entry.get("id") and entry.get("module") == module))), None)
        env_name = credential_name(identity, row)
        source = "environment" if EXPLICIT_CREDENTIALS.get(env_name) else "amplifier-keys" if env_name in stored else ""
        output.append({"id": identity, "source": source, "envName": env_name,
                       "configured": bool(row), "credentialAvailable": bool(os.environ.get(env_name)) or env_name in stored,
                       "model": str((row or {}).get("config", {}).get("default_model", ""))})
    ordered = ordered_rows(configured)
    primary = row_id(ordered[0]) if ordered else ""
    return {"cliInstalled": True, "setupSupported": supported, "configured": bool(ordered), "primary": primary,
            "providers": output, "order": [{"id": row_id(row), "module": row.get("module", "")} for row in ordered],
            "githubCliAvailable": bool(github_cli_token())}


def save(request):
    if importlib.util.find_spec("amplifier_foundation.settings") is None:
        raise SetupError("Update Amplifier to configure providers in Muxterm")
    from amplifier_foundation.settings import update_settings
    identity = request.get("provider")
    if identity not in PROVIDERS:
        raise SetupError("Unsupported provider")
    module = PROVIDERS[identity]
    existing = next((entry for entry in rows() if isinstance(entry, dict) and row_id(entry) == identity), None)
    env_name = credential_name(identity, existing)
    method = request.get("credentialSource")
    key = request.get("apiKey", "")
    explicit_env = EXPLICIT_CREDENTIALS.get(env_name, False)
    KeyManager()  # Load Amplifier-managed keys before checking availability.
    if method not in ("environment", "private-key", "github-cli") or (method == "github-cli" and identity != "github-copilot"):
        raise SetupError("Choose a credential source")
    if method == "github-cli":
        key = github_cli_token()
        if not key:
            raise SetupError("GitHub CLI sign-in is unavailable. Sign in to GitHub CLI or enter a token.")
        env_name = "AMPLIFIER_GITHUB_COPILOT_GITHUB_TOKEN"
        KeyManager().save_key(env_name, key)
        os.environ[env_name] = key
    if method == "private-key":
        if explicit_env:
            raise SetupError(f"{env_name} is already set in Muxterm's environment. Use that key or change the environment first")
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9._-]{8,16000}", key):
            raise SetupError("Enter a valid API key")
        if identity == "github-copilot":
            env_name = "AMPLIFIER_GITHUB_COPILOT_GITHUB_TOKEN"
        KeyManager().save_key(env_name, key.strip())
        os.environ[env_name] = key.strip()
    elif method == "environment" and (key or not os.environ.get(env_name)):
        raise SetupError(f"{env_name} is not available in Muxterm's environment")

    model = request.get("model", "")
    if not isinstance(model, str) or len(model) > 200 or (model and not re.fullmatch(r"[A-Za-z0-9_.:/-]+", model)):
        raise SetupError("Model name is invalid")

    def mutate(settings):
        config = settings.setdefault("config", {})
        providers = config.setdefault("providers", [])
        if not isinstance(providers, list):
            raise SetupError("Amplifier provider settings are malformed")
        existing = next((entry for entry in providers if isinstance(entry, dict) and row_id(entry) == identity), None)
        if existing is None:
            existing = {"id": identity, "module": module, "config": {}}
            providers.append(existing)
        existing["id"] = identity
        existing["module"] = module
        values = existing.setdefault("config", {})
        values["github_token" if identity == "github-copilot" else "api_key"] = "${" + env_name + "}"
        if model:
            values["default_model"] = model
        if "priority" not in values:
            values["priority"] = 1 if len(providers) == 1 else max(
                (entry.get("config", {}).get("priority", 100) for entry in providers if entry is not existing and isinstance(entry, dict)), default=0) + 1

    update_settings(get_amplifier_home() / "settings.yaml", mutate)
    return state()


def check(request):
    if importlib.util.find_spec("amplifier_foundation.settings") is None:
        raise SetupError("Update Amplifier before checking provider connections")
    identity = request.get("provider")
    if identity not in PROVIDERS:
        raise SetupError("Unsupported provider")
    module = PROVIDERS[identity]
    configured = next((entry for entry in rows() if isinstance(entry, dict) and
                       row_id(entry) == identity), None)
    if configured is None:
        raise SetupError("Save this provider first")
    KeyManager()  # Loads private keys into this short-lived process.
    env_name = credential_name(identity, configured)
    if not os.environ.get(env_name):
        raise SetupError(f"{env_name} is unavailable")
    from amplifier_app_cli.provider_sources import ensure_provider_installed, is_provider_module_installed
    if not is_provider_module_installed(module) and not ensure_provider_installed(module):
        raise SetupError("Amplifier could not install this provider module")
    from amplifier_app_cli.provider_loader import get_provider_models
    if identity == "github-copilot":
        os.environ["COPILOT_AGENT_TOKEN"] = os.environ[env_name]
    models = get_provider_models(module, collected_config={
        "github_token" if identity == "github-copilot" else "api_key": os.environ[env_name]})
    if not models:
        raise SetupError("The provider returned no available models")
    return {"ok": True, "modelCount": len(models)}


def reorder(request):
    from amplifier_foundation.settings import update_settings
    current = [row_id(row) for row in ordered_rows(rows())]
    requested = request.get("ids")
    if request.get("expectedIds") != current or not isinstance(requested, list) or len(requested) != len(current) or set(requested) != set(current) or len(set(requested)) != len(requested):
        raise SetupError("Provider connections changed. Refresh the list before saving order.")
    def mutate(settings):
        scoped = settings.setdefault("config", {}).setdefault("providers", [])
        for priority, identity in enumerate(requested, 1):
            next(row for row in scoped if isinstance(row, dict) and row_id(row) == identity).setdefault("config", {})["priority"] = priority
        settings.pop("provider_order", None)
    update_settings(get_amplifier_home() / "settings.yaml", mutate)
    return state()


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
        elif action == "reorder":
            result = reorder(request)
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
