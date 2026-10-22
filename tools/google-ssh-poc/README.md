# Google callback over temporary SSH: standalone PoC

This is a standalone container experiment, not an integrated muxterm feature.
It never starts muxterm or sessiond, installs services, or changes production
configuration. It uses a temporary SSH server, a callback bound only to container
loopback, PKCE S256, and a random OAuth state. It does not implement an MCP server.

## Transport demonstration (no Google credentials)

```bash
./start.sh simulate
```

Run the displayed SSH command on the browser's computer. For a LAN demonstration,
explicitly expose the temporary SSH port on the server's LAN address:

```bash
POC_BIND_ADDRESS=10.0.0.42 ./start.sh simulate
```

Read the pairing password from the printed private runtime path using a trusted
server console. Compare the displayed host fingerprint through that same trusted
channel; do not trust a password or fingerprint delivered through plain HTTP.
Open the link printed in the SSH session. The browser page explicitly identifies
the result as simulation. No Google credentials are loaded in this mode.

## Real Google experiment

Remove the exited transport container, then start a fresh attempt:

```bash
docker rm muxterm-google-ssh-poc
POC_BIND_ADDRESS=10.0.0.42 ./start.sh google /absolute/path/to/client.json
```

The JSON must be a Desktop OAuth client in a project with Gmail API enabled and
your account listed as a test user. Only the application reads this file. It is
mounted read-only, never copied into the image, printed, or committed. The sole
requested scope is `https://www.googleapis.com/auth/gmail.readonly`.

After opening the Google consent URL from the laptop SSH session, the callback
crosses the tunnel to the container. The application exchanges the code, forces
one refresh, and lists Gmail labels. Only the label count is printed, not names,
message contents, authorization codes, or tokens. Success saves `token.json` with
mode 0600 in the private runtime directory. Protect this file as an account secret.
The temporary endpoint shuts down on completion or after ten minutes.

To verify persistence after the SSH container exits, use the SAME credential and
runtime paths printed during that real attempt:

```bash
docker run --rm --user "$(id -u):$(id -g)" \
  --cap-drop ALL --security-opt no-new-privileges --read-only \
  --mount type=bind,src=/absolute/path/to/client.json,dst=/credentials/client.json,readonly \
  --mount type=bind,src=/absolute/runtime/path,dst=/data \
  muxterm-google-ssh-poc:local -credentials /credentials/client.json -verify
```

This opens no SSH or HTTP listener. It forces a refresh and a Gmail label read.
Do not inspect or paste `token.json` into a transcript. Delete the runtime token
when finished and revoke the experimental app in your Google account settings.

## Limits and security boundaries

- Google consent requires a human; simulated callbacks are not Google evidence.
- Google's documented desktop loopback flow does not explicitly endorse the
  remote-server-over-SSH deployment. Policy suitability remains unverified.
- Only forwarding to the exact callback address and port is allowed. No shell,
  PTY, SFTP, arbitrary commands, remote forwarding, or agent forwarding is provided.
- One SSH connection is admitted per attempt. Interrupted connections require a
  fresh container and runtime directory. Authentication attempts per connection
  are bounded, but this PoC is not a hardened public Internet SSH service.
- LAN exposure is opt-in. A phone without an SSH client cannot use this workflow.
- The token is protected by filesystem permissions, not encryption at rest.
- Testing-mode Google grants for Gmail generally expire after seven days.
- Production app verification, user isolation, auditing, packaging, and polished
  pairing UI are not implemented. Do not deploy this as a production login service.

## Static validation

```bash
docker run --rm -v "$PWD:/src" -w /src golang:1.24-alpine \
  sh -c 'go build -o /tmp/google-ssh-poc ./... && go vet ./...'
```

Behavior must be verified with a real SSH connection and browser. Do not add unit
tests or put verification artifacts in this source directory.
