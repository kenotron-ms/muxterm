/**
 * Status classification logic for muxterm panes/sessions.
 *
 * Classifies panes into three states:
 * - needs-input: Terminal is waiting for user input (prompt visible)
 * - running: Active command execution in progress
 * - completed: Command has finished (exit code received or prompt ready)
 *
 * Detection is based on:
 * - OSC 133 shell integration markers (when available)
 * - Terminal output activity patterns
 * - Cursor position and visibility
 */

import type { PaneStatus } from '../types.js';
import { terminalRegistry } from './terminal-registry.js';
import type { Terminal } from '@xterm/xterm';

/**
 * Time window for "recent activity" detection (ms).
 * Output within this window = running, otherwise check other signals.
 */
const ACTIVITY_WINDOW_MS = 2000;

/**
 * Classify a pane's current execution status.
 *
 * Strategy:
 * 1. Check for recent output activity -> running
 * 2. Check terminal cursor state (prompt-like patterns) -> needs-input
 * 3. Default to completed if no clear signals
 *
 * This is a heuristic-based approach. More accurate detection would require:
 * - OSC 133 shell integration (future enhancement)
 * - PTY process state from sessiond (future enhancement)
 */
export function classifyPaneStatus(
  paneId: number,
  lastActivityTimestamp: number | undefined,
): PaneStatus {
  const now = performance.now();
  const term = terminalRegistry.getTerminal(paneId);

  // No terminal yet (pre-attach) -> default to running
  if (!term) return 'running';

  // Recent output activity -> running
  if (lastActivityTimestamp && now - lastActivityTimestamp < ACTIVITY_WINDOW_MS) {
    return 'running';
  }

  // Check terminal buffer state for prompt signals
  const status = classifyFromTerminalState(term);
  return status;
}

/**
 * Analyze terminal buffer state to detect prompt-like patterns.
 *
 * Heuristics:
 * - Cursor on last line + no scrollback activity = needs-input (prompt ready)
 * - Otherwise = completed (command finished, waiting for next action)
 */
function classifyFromTerminalState(term: Terminal): PaneStatus {
  const buffer = term.buffer.active;
  const cursorY = buffer.cursorY;
  const baseY = buffer.baseY;

  // Cursor on the last visible line (typical prompt position)
  const onLastLine = cursorY === buffer.length - 1 - baseY;

  // Simple heuristic: cursor on last line = needs-input (prompt ready)
  // Otherwise = completed (command done, no clear signal)
  if (onLastLine) {
    return 'needs-input';
  }

  return 'completed';
}

/**
 * Activity tracker for detecting "running" state via recent output.
 *
 * Usage:
 * - Call trackActivity(paneId) whenever terminal receives output
 * - classifyPaneStatus() uses this timestamp to detect running state
 */
export class ActivityTracker {
  private lastActivity = new Map<number, number>();

  track(paneId: number): void {
    this.lastActivity.set(paneId, performance.now());
  }

  get(paneId: number): number | undefined {
    return this.lastActivity.get(paneId);
  }

  clear(paneId: number): void {
    this.lastActivity.delete(paneId);
  }
}
