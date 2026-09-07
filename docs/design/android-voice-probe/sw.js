/*
 * sw.js -- service worker for the Android voice probe.
 *
 * It exists for two reasons, and neither of them is audio.
 *
 * 1. INSTALLABILITY. Chrome's install criteria have required a service worker
 *    with a fetch handler for most of the API's life. Recent Chrome no longer
 *    requires one, but shipping a trivial pass-through handler makes the probe
 *    installable on every Chrome the user might be running, which matters
 *    because the whole point of the probe is comparing an installed WebAPK
 *    against a browser tab.
 *
 * 2. IT ANSWERS R1 ON THE USER'S OWN DEVICE. The probe page asks this worker
 *    to report which audio APIs exist in ServiceWorkerGlobalScope. The answer
 *    is "none of them", and it is measured rather than asserted. See
 *    reportCapabilities() below.
 *
 * This worker deliberately caches NOTHING. A probe that serves a stale copy of
 * itself is an instrument that lies.
 */

const PROBE_SW_VERSION = '1';

self.addEventListener('install', (event) => {
  // Take over immediately; there is nothing to precache and nothing to migrate.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Wipe anything a previous version of this worker might have left.
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

// Network pass-through. Present so the page is installable; does nothing else.
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

/**
 * The measurement behind R1.
 *
 * Every entry below is a name the page COULD have used if a service worker
 * were a viable host for a voice session. Each is probed by feature detection
 * in this global scope, so the result reflects the exact Chrome build on the
 * user's phone rather than a specification the browser may not follow.
 */
function reportCapabilities() {
  const has = (fn) => {
    try {
      return !!fn();
    } catch (err) {
      return false;
    }
  };

  return {
    swVersion: PROBE_SW_VERSION,
    scope: self.registration ? self.registration.scope : '(unknown)',
    // navigator in a service worker is a WorkerNavigator, which has no
    // mediaDevices member at all -- so getUserMedia is not merely denied,
    // it is unreachable.
    hasNavigatorMediaDevices: has(() => self.navigator && self.navigator.mediaDevices),
    hasGetUserMedia: has(
      () => self.navigator && self.navigator.mediaDevices && self.navigator.mediaDevices.getUserMedia,
    ),
    hasRTCPeerConnection: has(() => self.RTCPeerConnection),
    hasAudioContext: has(() => self.AudioContext || self.webkitAudioContext),
    hasOfflineAudioContext: has(() => self.OfflineAudioContext),
    hasAudioWorklet: has(() => self.AudioWorklet),
    hasMediaStream: has(() => self.MediaStream),
    hasAudio: has(() => self.Audio),
    hasWakeLock: has(() => self.navigator && self.navigator.wakeLock),
    hasMediaSession: has(() => self.navigator && self.navigator.mediaSession),
    // For contrast: things a service worker genuinely does have.
    hasFetch: has(() => self.fetch),
    hasIndexedDB: has(() => self.indexedDB),
    hasPushManager: has(() => self.PushManager),
    hasNotification: has(() => self.Notification),
  };
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'probe:capabilities') return;
  const reply = { type: 'probe:capabilities:result', at: Date.now(), caps: reportCapabilities() };
  if (event.ports && event.ports[0]) {
    event.ports[0].postMessage(reply);
    return;
  }
  if (event.source && event.source.postMessage) event.source.postMessage(reply);
});
