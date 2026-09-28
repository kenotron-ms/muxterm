# SDK chat attachment backend

`internal/chatattachments` stores each upload under
`$XDG_DATA_HOME/muxterm/sdk-chat-attachments/<id>/` (falling back to
`~/.local/share/muxterm/sdk-chat-attachments`). Each directory is mode 0700;
its original-named file and `metadata.json` are mode 0600. The 32-character
random ID is the browser-facing handle. The browser never sends a filesystem
path. This store is separate from project folders and from CoS attachments.

## Route seam

The SDK chat server's route registration can mount the new package with its
existing auth wrapper:

```go
root, err := chatattachments.DefaultRoot()
if err != nil { return err }
store, err := chatattachments.NewStore(root)
if err != nil { return err }
if err := chatattachments.RegisterRoutes(s.mux, store, protect); err != nil { return err }
```

`RegisterRoutes` registers these protected routes:

* `POST /api/sdk-chat-attachments` — one `multipart/form-data` field named
  `file`, with header `X-Muxterm-Chat-Attachment: 1`. Returns HTTP 201 and
  `{id,filename,contentType,kind,size}`. `kind` is `image` only when magic
  bytes identify PNG, JPEG, GIF, or WebP; every other accepted type is `file`.
  An image MIME claim with non-image bytes is rejected.
* `GET /api/sdk-chat-attachments/{id}` — returns the original bytes as a
  download, with stored content type and `X-Content-Type-Options: nosniff`.

Both routes require muxterm's existing authentication wrapper. The upload
header prevents a cross-origin form post from using an ambient cookie.
The package does not mount itself in `server.New`: that route registration
lives in an existing file outside this lane's new-files-only scope.

## Harness seam

Call **`(*chatattachments.Store).ResolvePath(id)`** after accepting an ID from
an authenticated chat request. It returns `(absolutePath, attachment, error)`.
The path is the local file to pass to Codex, Claude, or Amplifier; inspect
`attachment.Kind` to send an image as an image and other bytes as a file.
The resolver validates the ID, metadata, file type, and stored size. Do not
derive the path from the ID in a chat driver.

Each file is limited to **20 MiB**. Uploads above that return HTTP 413 with
`{"error":"attachment_too_large","reason":"attachment exceeds the 20 MiB limit"}`.
The multipart request has another 1 MiB allowance for framing, so normal
browser multipart overhead does not lower the file limit.
