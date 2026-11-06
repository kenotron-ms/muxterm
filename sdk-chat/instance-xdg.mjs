import { homedir } from 'node:os';
import { join } from 'node:path';

// Muxterm's own chat state (origin capabilities, connection markers, managed
// agent binaries, the server handoff) lives in THIS instance's XDG dirs. The
// sidecar's process.env carries the USER's XDG dirs so every agent harness
// child it spawns inherits them; the server records the instance's values as
// MUXTERM_INSTANCE_XDG_* (sdkSidecarXDGEnv in internal/server/sdk_chat.go).
// With an older server that does not set them, the instance and the user are
// the same, so falling back to the sidecar's own values is exactly right.
export function instanceXdg(name) {
  return process.env[`MUXTERM_INSTANCE_XDG_${name}`] || process.env[`XDG_${name}`] || '';
}
export function instanceDataHome() {
  return instanceXdg('DATA_HOME') || join(homedir(), '.local', 'share');
}
export function instanceRuntimeDir() {
  return instanceXdg('RUNTIME_DIR') || `/tmp/muxterm-${process.getuid()}`;
}
// The XDG routing entries every `muxterm mcp` / `connection-mcp` subprocess
// needs to reach this instance.
export function instanceMcpEnv() {
  const env = {};
  const runtime = instanceXdg('RUNTIME_DIR');
  const data = instanceXdg('DATA_HOME');
  if (runtime) env.XDG_RUNTIME_DIR = runtime;
  if (data) env.XDG_DATA_HOME = data;
  return env;
}
