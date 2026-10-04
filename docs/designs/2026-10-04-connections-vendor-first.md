# Connections: use service-owned servers

The Connections screen names services, not transport protocols. It lists GitHub, Microsoft 365, and Google Workspace products. A catalog entry is discovery only until its actual authentication and tool check succeed.

## GitHub

Muxterm launches the [official local GitHub server](https://github.com/github/github-mcp-server) over stdio for new chats in Codex, Claude Code, and Amplifier. The owner installs `gh` and `github-mcp-server`, then signs in using `gh auth login --hostname github.com`. Muxterm never registers its own OAuth app or stores a GitHub credential. The fixed `muxterm connection-mcp github` command obtains the active GitHub CLI token without a shell and gives it only to the vendor child process through its environment. Token output and vendor stderr are excluded from muxterm logs and API responses.

The command always starts `github-mcp-server stdio --read-only --toolsets=context,repos,issues,pull_requests`. It removes inherited GitHub token and tool-configuration environment variables, so they cannot widen the exposed tools. The owner enables GitHub from Connections only after tool discovery and the service's read-only `get_me` call verify the current account. A local `github-enabled` marker contains that preference and no token. Disabling removes the marker for new chats; it does not sign out GitHub CLI or revoke GitHub's grant. Existing chats retain their startup server list.

The page reports **Ready** only after live tool discovery. Finding a CLI login or an installed binary alone is setup information. GitHub's server owns tool schemas, API calls, and GitHub authentication behavior. The first version targets `github.com`; enterprise hosts and per-chat grants need separate product decisions.

## Other services

Microsoft and Google rows remain setup/discovery entries in this PR. Their provider-owned connection paths must be validated before the page can call them connected. Microsoft Work IQ may require tenant administration and usage billing; Google's Workspace service endpoints are in Developer Preview.

## User-supplied remote services

The Remote services page accepts a public HTTPS Streamable HTTP endpoint and an OAuth client registered by the owner. Muxterm reads protected-resource and authorization-server metadata, checks the advertised resource and issuer, and uses one-use state, PKCE S256, an exact callback, and issuer validation when the provider supplies it. OAuth credentials and rotating tokens stay in an owner-readable local file; the browser API does not return them. Public-address checks run after DNS resolution and redirects are refused.

The official Go MCP SDK handles remote MCP sessions and tool calls. Muxterm owns the browser callback because this pinned SDK version does not expose the newer authorization handler in the repository's Go toolchain. Tool discovery begins with an empty allowlist; the owner explicitly enables tool names shared by all three chat harnesses. Selected tools may write or delete service data, so the page describes that access before enabling them. Reauthorization invalidates older bridge sessions.

Provider-owned local servers remain the preferred path where available. The remote flow exists for services that require a client registration and do not supply an adequate local sign-in server. Live provider consent and token refresh still need verification with eligible accounts.

## Source notes

- [GitHub local server setup, token precedence, toolsets, and read-only mode](https://github.com/github/github-mcp-server)
- [GitHub local server OAuth behavior](https://github.com/github/github-mcp-server/blob/main/docs/oauth-login.md)
- [GitHub CLI token and active-host selection](https://cli.github.com/manual/gh_auth_token)
- [Microsoft Work IQ prerequisites](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/overview)
- [Google Workspace service setup](https://developers.google.com/workspace/guides/configure-mcp-servers)
- [OAuth protected-resource metadata](https://www.rfc-editor.org/rfc/rfc9728)
- [OAuth authorization-server issuer in the callback](https://www.rfc-editor.org/rfc/rfc9207)
