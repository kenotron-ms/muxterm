/**
 * artifact-open.ts -- "show this file", from somewhere that is not the DOM.
 *
 * WHY THIS EXISTS AT ALL. Opening the viewer from a click is easy: the Files
 * applet fires `applet-navigate`, it bubbles up to <mux-applets>, done. But the
 * chief of staff has to be able to open it too -- somebody says "show me the
 * design doc", and the answer has to appear on their screen. That request
 * arrives as a websocket frame in app.ts, which is OUTSIDE the applet host's
 * shadow tree. A DOM event dispatched there travels UP, away from the host, and
 * reaches nothing.
 *
 * THE OPTIONS, AND WHY THIS ONE. app.ts could reach down --
 * `querySelector('mux-cos').shadowRoot.querySelector('mux-applets')` -- which
 * works and hard-codes Mission Control's internal structure into the app shell.
 * Or <mux-applets> could subscribe to something, which puts a second navigation
 * entrance in the host. Instead the ARTIFACT APPLET subscribes, and it is
 * always mounted (the host mounts every registered applet for its lifetime and
 * only toggles visibility), so it is always there to hear. It then asks to be
 * shown the ordinary way, by firing `applet-navigate` from itself, INSIDE the
 * host's tree, through the one entrance that already exists.
 *
 * The result: opening the viewer from an agent is a zero-line change to
 * <mux-applets>, and the host still has exactly one way to be navigated.
 *
 * ON D3.4 -- "applet-navigate is only ever fired from a gesture". A relayed
 * request is still a gesture. The distinction that rule draws is between A
 * PERSON ASKING and A POLL RETURNING SOMETHING NEW: the second must never move
 * the surface out from under a reader, and it still cannot -- nothing here is
 * reachable from a data change. Somebody asking their chief of staff to show
 * them a document is the first kind, and arrives by voice or by typing instead
 * of by a click.
 *
 * Deliberately not an EventTarget on window: a global event name is a public
 * API anything can fire, and this is a two-callsite seam.
 */

/**
 * One ephemeral, read-only document held only in this browser. It is used for
 * safe Mission Control protocol detail/preview results when there is no file
 * path to hand to the existing Viewer. It is never published, persisted, or
 * sent back to a server.
 */
export interface ViewerDocument {
  readonly title: string;
  readonly text: string;
  readonly subtitle: string;
}

export type ViewerOpenRequest =
  | Readonly<{ readonly kind: 'artifact'; readonly path: string }>
  | Readonly<{ readonly kind: 'document'; readonly document: ViewerDocument }>;

type Listener = (request: ViewerOpenRequest) => void;

const listeners = new Set<Listener>();

/**
 * Ask for a file to be shown. Called by app.ts when the server pushes an
 * {"openArtifact":...} frame.
 *
 * Does nothing when nothing is listening, which is the correct behaviour and
 * not a failure: Mission Control may not be mounted yet. The server already
 * told the caller how many browsers it reached; a browser that is not ready to
 * show a document is not a lie it can correct.
 */
export function requestArtifactOpen(path: string): void {
  const p = (path ?? '').trim();
  if (p === '') return;
  // Iterated directly: JS Set iteration tolerates a listener unsubscribing
  // itself mid-pass, which is the only re-entrancy this seam can have.
  for (const fn of listeners) fn({ kind: 'artifact', path: p });
}

/**
 * Present an already-received read-only document in the existing Viewer.
 * This is intentionally a one-process handoff rather than a generated file:
 * no filesystem write, URL, publication, or second applet is involved.
 */
export function requestViewerDocument(document: ViewerDocument): void {
  const title = document.title.trim();
  if (title === '' || document.text === '') return;
  const safe: ViewerDocument = Object.freeze({
    title,
    text: document.text,
    subtitle: document.subtitle.trim(),
  });
  for (const fn of listeners) fn({ kind: 'document', document: safe });
}

/** Listen for open requests. Returns the unsubscribe. */
export function onArtifactOpen(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
