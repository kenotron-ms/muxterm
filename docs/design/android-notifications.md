# The phone tells you when a lane needs you

A lane that goes `blocked` is waiting on a human. Until now the only way to
find that out was to open the app and look — which is precisely what the person
who dispatched twelve lanes and walked away is not doing. An unattended blocked
lane is wasted time, and that is the whole reason this exists.

This file records what was **built and verified**, the architecture decision
behind it, and — because it is the question everyone asks second — exactly what
server-side push would take, and why it is not what shipped.

---

## What notifies

Transitions **into** a state, never a state persisting.

| into | notifies | channel | why |
|---|---|---|---|
| `blocked` | yes, high | Lanes needing you | it is waiting on the human. The point. |
| `failed` | yes | Lane completions | something broke and they want to know. |
| `done` | yes, low | Lane completions | useful, not urgent. |
| `working` | **no** | — | the normal case; constant noise. |
| `stopped` | **no** | — | usually a consequence of something the user just did. |

### `doing` must never notify, and the guard is structural

`doing` is re-templated on **every tool call**. The daemon republishes the whole
session-state set whenever any field of any row changes
(`internal/sessiond/server.go`, `publishSessionState`), so a fleet of ten lanes
produces a new snapshot several times a second and almost none of them are a
state change. Notifying on `doing` would fire dozens of times a minute per lane
and the feature would be switched off within a day.

`TransitionDetector`'s entire memory is a `Map<sessionId, state>`. That is not
an optimisation — it is the guard. `doing` is not stored, so a change in `doing`
is not *representable* as a change, so no later edit can make it notify by
accident. `TransitionDetectorTest.doingChurnProducesNoTransitions` feeds real
wire JSON with ten different `doing` values and asserts zero transitions;
measured on a device, eight consecutive snapshots of pure `doing` churn produced
`0 transition(s)` and zero notifications.

**Do not add `doing` to that map.** It is not a helpful enhancement.

---

## Where detection lives, and why it is not a server push

Two shapes were on the table.

**(a) The server detects transitions and pushes to the device.** Correct in the
abstract, and the one that keeps working when the app is not installed in
memory at all. It needs three things this repo does not have: a push transport
that can wake a sleeping phone, a device registry in the daemon, and a
per-device notion of which fleet a device is entitled to see.

**(b) The app observes the fleet and raises notifications locally.** No push
infrastructure, no registry — but its usual form (a detector living in the
Activity) only runs while the app is open, which notifies the user about
exactly the changes they can already see and stays silent for every other one.
That is the inversion of the ask.

### The transport is the whole argument

On Android there is no third option hiding between them. To be reachable while
backgrounded a process must either be woken by **Firebase Cloud Messaging** —
Google's messaging service, a Google account, and a cloud dependency, all
explicitly out of scope — or **hold a socket open itself**, which requires a
foreground service.

So "server-side push" and "app-side detection" are not actually two transports.
Below the cloud layer they are the same one: a persistent connection from the
device. What shipped is (b) with the process-lifetime problem solved the way the
platform actually allows:

**`FleetWatchService`, a foreground service holding the daemon's existing
`session-state` WebSocket.**

The wrapper had already proved this shape works — `VoiceSessionService` keeps a
WebRTC conversation alive through a dark screen and a 45-second silence. This is
the same trick with a far cheaper payload: one socket, a 20-second ping, and a
map of short strings.

### What it does not cover, stated plainly

- **Force-stopped by the user, or killed by a vendor battery manager.** Silent
  until the app is opened again. `START_STICKY` covers a platform-initiated
  kill; it does not survive a user force-stop, and nothing does.
- **After a reboot, until the app is opened once.** No `BOOT_COMPLETED`
  receiver — deliberately, for now: an app that starts a foreground service at
  boot before the user has ever asked for notifications is a worse citizen than
  one that waits.
- **Deep Doze can suspend the socket.** The reconnect is silent by design (see
  below), so transitions that happened while it was down are adopted, not
  announced.
- **One server at a time.** The watcher follows the wrapper's configured URL.

Rejected alternatives, for the record: `WorkManager` and `JobScheduler` cap out
at a 15-minute period, which is far too slow for "this lane is waiting on you";
exact `AlarmManager` wakeups at that cadence are battery-hostile and would still
need a socket on each wake to learn anything.

### If server-side push is ever wanted, here is the bill

Nothing in this repo does push today — no FCM, no APNs, no Web Push, no VAPID
keys, no device tokens, no subscription table. A search for every one of those
terms across the Go, the TypeScript and the docs returns nothing. So it is a
green field, and it costs:

1. **A transport.** For Android that is FCM, and FCM means a Firebase project, a
   Google account, a `google-services.json` in the APK, and a server-side
   service-account credential. There is no self-hosted substitute that can wake
   a sleeping Android process.
2. **A device registry in the daemon.** Token, user identity, created/last-seen,
   and a way to expire a token the moment it stops being delivered. Tokens
   rotate; a registry that never forgets one is a slow leak of dead endpoints.
3. **An entitlement rule.** Today `/ws` is protected by `AuthMiddleware` and a
   `muxterm_session` cookie, so "which fleet may this connection see" is
   answered by the session. A push registry has no session at send time, so that
   question has to be answered again, at registration, and stored.
4. **Transition detection moved server-side** — the same rules as
   `TransitionDetector`, but per-device and stateful across restarts, which is
   strictly harder than doing it in one app process.
5. **The same anti-spam work, again.** Coalescing, the "already resolved" drop,
   and foreground suppression all still apply, and foreground suppression now
   needs the device to tell the server it is looking at the app.

That is a real project, and its payoff over what shipped is narrow: it survives
a force-stop and a reboot. Worth doing when someone is relying on this and hits
that edge. Not worth doing first.

---

## Not spamming anyone

This is the difference between a feature people keep and one they turn off.

### The reconnect storm

The app reconnects routinely — PR #94 made it wake on `visibilitychange`,
`focus` and `online` — and the daemon's `session-state` push is a **complete-set
replacement**, never a delta. A naive detector would therefore rediscover the
entire fleet on every reconnect and fire one notification per lane, every time
the user switched back to the app.

**The first snapshot of every connection is a baseline, not a diff.**
`TransitionDetector.reset()` is called before every dial; the first `observe()`
after it adopts silently and returns nothing.

That deliberately swallows transitions that happened while the socket was down.
It is the right trade: a user returning after an hour would otherwise get an
hour of history in one burst, about states that are already on the dashboard
they just opened.

Verified on a device: the server was killed, four lanes changed state
underneath — two into `blocked`, one `failed`, one `done` — the app backed off
1s/2s/4s/8s/16s, reconnected, logged `baseline adopted: 5 lane(s), 0
notifications`, and posted nothing.

### Coalescing

Transitions land in `AlertBuffer`, not in the shade. The buffer flushes once,
2.5 s after the *first* arrival — anchored to the first, not slid forward on
each new one, so a steady drip cannot postpone the flush forever. One flush
posts at most **two** notifications: one for the lanes needing you, one for the
lanes that finished. Both use fixed ids, so a later flush *replaces* the row
rather than stacking beside it.

Verified: four lanes changed in one snapshot and produced exactly two
notifications — `2 lanes need you` and `2 lanes finished` — each with an
`InboxStyle` line per lane.

### Two more subtractions

- **Already resolved.** At flush time an entry whose lane has since moved on is
  dropped. A lane that blocked and unblocked itself inside the window never
  interrupts anybody.
- **Being watched.** Nothing is posted while the Activity is resumed. Dropped,
  not deferred: a buzz two minutes later about something already seen is worse
  than silence. Verified: two transitions with the app in front produced
  `flush: nothing to post (foreground=true)`.

Where a choice was contested, the quieter option won and the alternative is
recorded in the PR. Under-notifying is recoverable; a storm makes someone turn
the feature off permanently.

---

## Permissions and channels

`POST_NOTIFICATIONS` is an Android 13+ **runtime** permission. The manifest line
grants nothing: on a fresh install `dumpsys package` reports
`POST_NOTIFICATIONS: granted=false` until the user answers a dialog. It is
requested at startup in the same single `requestPermissions` call as
`RECORD_AUDIO` — Android shows one dialog at a time and silently drops a second
request while one is in flight, so asking separately means only the first is
ever seen.

Three channels, so the user tunes this in Android's own settings — reachable by
long-pressing the notification, and outliving any preferences screen we could
write:

| id | name in settings | importance |
|---|---|---|
| `lanes_blocked` | Lanes needing you | HIGH (4), vibrates, badges |
| `lanes_finished` | Lane completions | LOW (2), silent |
| `lanes_watch` | Watching lanes | LOW (2), the service's ongoing row |

`IMPORTANCE_LOW` rather than `MIN` for the ongoing row, for the reason already
learned in `VoiceSessionService`: below `PRIORITY_LOW` the platform writes its
own, worse sentence about the app's foreground service into the drawer.

The in-app surface is one line in the back-button dialog — **Lane alerts:
on/off** — and nothing more. Per-lane rules are not in scope; channels are the
user's control.

### Tapping a notification

It brings the app to the foreground. That is the whole action, and it is the
best available: the muxterm web app is one page with **no per-workspace URL** —
nothing in `web/src` reads `location`, there is no routing, no hash, no
`pushState`. There is nothing to deep-link to. Inventing a route in the wrapper
would be fabricating web-app behaviour from the outside. If per-workspace deep
links are wanted, the web app needs a URL scheme first; the wrapper can follow
it in an afternoon.

---

## The wire detail that costs an afternoon

**`session-state-subscribe` requires `"ok": true`.**

It is a two-way switch, not an event. `internal/server/ws.go` does
`c.setSessionStateWanted(msg.OK)`, so a frame that omits the field unmarshals to
`OK=false` and turns the feed **off**. The daemon still replies
`session-state-subscribe-result` with `OK=true` — it understood the message —
and then sends nothing, forever.

```json
{"type":"session-state-subscribe","ok":true}
```

Found on a device, not in a test: the app logged a successful dial and an
acknowledged subscribe, and zero snapshots ever arrived. No JVM test of the
detector could have caught it.

The Android Auto lane's `car/FleetRepository.kt` sends the bare frame and will
show an empty car screen against a real server for the same reason. Not fixed
here — that file belongs to a branch in flight.

---

## Shape of the code

| file | what it is |
|---|---|
| `notify/TransitionDetector.kt` | pure. Snapshots in, state changes out. Holds `Map<sessionId, state>` and nothing else. |
| `notify/AlertBuffer.kt` | pure. Coalescing, per-lane collapse, the two drops, and every string that reaches the screen. |
| `notify/LaneRow.kt` | pure. The six wire fields this feature reads. |
| `notify/LaneNotifier.kt` | Android. Channels and posting. No policy. |
| `notify/FleetWatchService.kt` | Android. The foreground service, the socket, the cookie, the reconnect. |

Everything that decides *whether to interrupt a human* is in the pure half and
is covered by 31 JVM tests that need no device.

`LaneRow` is deliberately **not**
`car.FleetRepository.SessionRow`. Sharing it would couple two features that have
nothing in common but a wire format, and would put two lanes in one file.
