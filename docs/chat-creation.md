# Chat projects and folders

Chat projects are muxterm metadata stored with SDK chat records under the configured data home. Each project has a stable ID and a folder path. Multiple projects can use the same folder. Removing a project removes only its muxterm catalog row and moves its chats to Ungrouped; it does not touch the folder or native session data.

The new chat screen starts with Ungrouped selected. Select an existing project by name or choose New project and a folder. The first message starts the SDK session. The server creates a missing folder before starting it.

Set the starting location for the server folder picker in `config.toml`:

```toml
[chat]
default_base_home_folder = "/home/ken/work"
```

When this setting is absent, the server uses its home directory. Ungrouped chats use the same folder by default, and the folder can be changed on the new chat screen.
