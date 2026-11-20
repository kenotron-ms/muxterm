# Remote projects and chats

Use one Muxterm browser or Android client with a stable home Muxterm URL. On
other machines, install and run a Muxterm server under the SSH account that
owns the projects and coding-agent sign-ins. In **Settings → Remotes**, add or
reuse those SSH machines. The Chats sidebar discovers project folders and
sessions from their chat backends automatically; a network icon, machine name,
and green dot identify a reachable remote project.

In **New chat → Session location**, choose **Choose machine…**, select the SSH
node, then browse a folder or create a new project folder there. The same
dropdown offers **Set up SSH machine…**, which opens **Settings → Remotes**.
Its project files, agent process, and chat history stay on
that machine. The home server forwards chat requests over SSH; the client keeps
using the home URL. Reloading a chat link reconnects to the same node.

Each node needs a Muxterm version with the `chat-connect` helper and a running
server. SSH key access must work noninteractively from the home server. If the
remote binary is not on the SSH login shell's PATH, set
`MUXTERM_REMOTE_BINARY` on the home server to its absolute path on the nodes.
The project dot reports chat-backend reachability; an unreachable node's
existing project rows remain visible in the current client until it reloads.
