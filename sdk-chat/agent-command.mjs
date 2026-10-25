import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

// Resolve on each use so Refresh installed agents works without restarting the
// shared sidecar. The returned absolute path also works with the Claude SDK's
// pathToClaudeCodeExecutable option.
export function agentCommand(name, override) {
  const command = process.env[override]?.trim() || name;
  const entries = command.includes('/') || command.includes('\\')
    ? [command] : (process.env.PATH || '').split(delimiter).map(dir => join(dir || '.', command));
  const extensions = process.platform === 'win32' && !/\.[^/\\]+$/.test(command)
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const entry of entries) for (const extension of extensions) {
    const path = isAbsolute(entry) ? entry + extension : resolve(entry + extension);
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return path;
    }
    catch { /* Try the next PATH entry. */ }
  }
  throw new Error(`${name} CLI is unavailable. Install ${name}, sign in, then refresh installed agents in Muxterm.`);
}
