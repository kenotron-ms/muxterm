/** Browser-only API boundary for high-level Storybook examples. Each story
 * supplies the responses its real screen component expects. */
export type ApiFixture = (request: { url: URL; method: string; init?: RequestInit }) => Response | Promise<Response>;

let activeFixture: ApiFixture | undefined;

declare global {
  interface Window {
    __muxStorybookNativeFetch?: typeof fetch;
    __muxStorybookNativeEventSource?: typeof EventSource;
    __muxStorybookEventSourcePatched?: boolean;
  }
}

/** Chat name and transcript streams have no server in Storybook. Initial
 * history and mutations still use each story's API fixture. */
class FixtureEventSource extends EventTarget {
  readonly url: string;
  readonly withCredentials = false;
  readyState: number = EventSource.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) { super(); this.url = url; }
  close(): void { this.readyState = EventSource.CLOSED; }
}

export function useApiFixture(fixture?: ApiFixture): void {
  activeFixture = fixture;
  window.__muxStorybookNativeFetch ??= window.fetch.bind(window);
  window.__muxStorybookNativeEventSource ??= window.EventSource;
  if (!window.__muxStorybookEventSourcePatched) {
    const NativeEventSource = window.__muxStorybookNativeEventSource;
    window.EventSource = function (input: string | URL, init?: EventSourceInit): EventSource {
      const url = new URL(String(input), window.location.href);
      if (activeFixture && (url.pathname.endsWith('/api/sdk-chat-names/events') ||
        /\/api\/sdk-chats\/[^/]+\/events$/.test(url.pathname))) {
        return new FixtureEventSource(url.href) as unknown as EventSource;
      }
      return new NativeEventSource(input, init);
    } as unknown as typeof EventSource;
    Object.assign(window.EventSource, { CONNECTING:0, OPEN:1, CLOSED:2 });
    window.__muxStorybookEventSourcePatched = true;
  }
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (activeFixture && url.pathname.includes('/api/')) {
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      return activeFixture({ url, method, init });
    }
    return window.__muxStorybookNativeFetch!(input, init);
  };
}

export function fixtureJSON(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
