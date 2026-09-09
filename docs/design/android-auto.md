# muxterm on the car screen

The scope is narrow on purpose. No terminals in the car. The screen shows two
things — what needs the driver's input, and what is running — and everything the
driver wants to *do* they do by talking to the chief of staff. One screen, no
drill-down, which is also exactly what the driver-distraction rules want.

The drawn design and the API rationale behind the template choice live in the
sibling lane's `docs/design/android-auto-ui.md` (repo `muxterm-car-ui`). This
file records what was **built and verified**, and the one finding that changes
what is possible.

---

## The blocking finding: a sideloaded build will not run in a real car

This is the thing to know before spending another hour on it, quoted verbatim
from [Test Android apps for cars](https://developer.android.com/training/cars/testing):

> To test your app in real vehicles, you must install it from a trusted source
> such as Google Play, with one exception detailed in Allow unknown sources. You
> can use Internal App Sharing or an Internal Test Track to distribute your app
> to devices without going through the Google Play review process.

and, under **Allow unknown sources**:

> Android Auto has a developer option that lets you run apps that aren't
> installed from a trusted source. This setting applies to media, messaging
> notifications, and parked apps but **doesn't apply to apps built using the
> Android for Cars App Library.**

So the developer-mode "unknown sources" toggle — the obvious escape hatch, and
the one worth hoping for — explicitly does not cover this kind of app. `adb
install` of a debug APK will never appear on a real head unit.

**What this does and does not block:**

| Path | Works? | Google involvement |
|---|---|---|
| Desktop Head Unit, debug APK over `adb install` | **yes** — the documented dev loop | none |
| Automotive OS emulator, debug APK | **yes** — verified below | none |
| Real car, sideloaded debug APK | **no** — the quote above | — |
| Real car, Play **Internal App Sharing** | yes | Play Console account, release-signed; **no review** |
| Real car, Play **Internal Test Track** | yes | Play Console account, release-signed; **no review** |

The honest summary is not "Play approval is required". Review is *not* required.
What is required is a Play-Console-mediated install path: a developer account, a
release signing key, and an upload. The app is never listed, never public, never
reviewed. That is the price of the car screen, and it is worth knowing before
building rather than after.

---

## Category: `androidx.car.app.category.IOT`

The Car App Library only permits a fixed set of categories, and an app declares
one in its `CarAppService` intent filter. The complete supported set is
NAVIGATION, POI, IOT and WEATHER (stable), plus MEDIA, MESSAGING and CALLING
(experimental, and restricted to internal/closed test tracks). **There is no
generic "utility" or "template" category.**

IOT is the only stable category that fits a list of statuses. NAVIGATION would
oblige turn-by-turn behaviour and unlock map templates the screen has no use
for; POI and WEATHER are semantically wrong; MESSAGING is the closest fit on
paper but is `@ExperimentalCarApi` and track-restricted. IOT requires car API
level 6, hence `androidx.car.app.minCarApiLevel = 6` in the manifest.

Verified at runtime — the host's own log, negotiating with this app:

```
CarApp.H: App: [io.ampbox.muxterm/.car.MuxtermCarAppService]
          app info: [Library version: [1.7.0] Min Car Api Level: [6]
                     Latest Car App Api Level: [8]]
          Host min api: [1]  Host max api: [7]
CarApp.H: App: [io.ampbox.muxterm/.car.MuxtermCarAppService],
          Host negotiated api: [7]
```

---

## What was built

`androidx.car.app:app:1.7.0`, in `io.ampbox.muxterm.car`:

| File | Role |
|---|---|
| `MuxtermCarAppService.kt` | the service the host binds; `ALLOW_ALL_HOSTS_VALIDATOR` in debug only |
| `MuxtermSession.kt` | owns the feed's lifetime, hands back the one screen |
| `FleetScreen.kt` | `ListTemplate` with two `SectionedItemList`s |
| `FleetRepository.kt` | the `/ws` session-state feed, one socket process-wide |

Three constraints shaped the code more than anything else:

**Status cannot be carried by colour.** Not "should not" — cannot, reliably. The
host chooses light/dark variants itself to hold its own contrast ratio, may
substitute a default when a custom colour fails that check, and inside a row
only the *secondary* line accepts colour at all. So priority is carried by words
and position: "NEEDS MY INPUT" is a literal heading at the literal top. There is
no `CarColor` anywhere in the car package.

**The template quota is a trap.** Android Auto allows 5 templates per task, and
the last one must be Navigation/Pane/Message/MediaPlayback/SignIn/LongMessage —
`ListTemplate` is not on that list. A one-screen list app cannot spend steps
pushing screens, so refresh is `Screen.invalidate()` on the same screen. That is
not an optimisation here; it is the only mechanism that works.

**Blocked wins space, but working never goes silent.** The row budget comes from
`ConstraintManager.getContentLimit(CONTENT_LIMIT_TYPE_LIST)` at runtime, never a
hardcoded 6. Blocked sessions get up to `budget - 1` rows; working sessions take
the rest but always keep at least one, so "work is happening" is never invisible.
A truncated group ends with a "+N more" row.

One API detail that has to be handled rather than discovered in the car:
`addSectionedList()` throws on an empty list or an empty header, so an empty
group is never added, and a fleet with nothing blocked and nothing working falls
back to a `MessageTemplate` instead.

---

## Verified rendering, 2026-09-09

Android Auto cannot be emulated — the Desktop Head Unit tethers to a real phone.
**Android Automotive OS can be**, and it runs the same Google templates host, so
that is where this was proved without a phone in the room.

`system-images;android-33;android-automotive;x86_64` carries
`com.google.android.apps.automotive.templates.host`. The debug variant adds
`androidx.car.app:app-automotive` and a `CarAppActivity` (see
`android/app/src/debug/AndroidManifest.xml` for why that is debug-scoped), and
`android/tools/fake-fleet-feed.py` supplies a session-state feed so there is
something real to render.

```sh
./android/tools/fake-fleet-feed.py 8491 &
adb -s emulator-5558 install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5558 shell am start -n io.ampbox.muxterm/.MainActivity -e url http://10.0.2.2:8491
adb -s emulator-5558 shell am start -n io.ampbox.muxterm/androidx.car.app.activity.CarAppActivity
```

![the car screen](img/car-screen.png)

The fixture pushes six sessions: two blocked, two working, one `done` and one
`failed`. The screen shows the four it should and drops the two it should not.

Then it pushes a second snapshot in which one blocked lane frees itself and a
new one appears, and the same screen re-renders — no new `Screen` pushed, no
template budget spent:

![refresh](img/car-screen-refresh.png)

`android-icons` moves from NEEDS MY INPUT to ONGOING with its detail line
changed, and `head-unit` appears. 13,162 pixels differ between the two captures.

**One bug this found, and it was in the fixture, not the app.** The first version
of `fake-fleet-feed.py` ignored WebSocket ping frames. OkHttp is configured with
a 20-second ping interval, so the client dropped the connection and reconnected
every 20 seconds — which looks exactly like an app bug and was not one. The
fixture answers pings now. Worth remembering when the real server is in the loop.

### The gap in this proof

Automotive OS is not Android Auto. The templates host, the template code, the
category negotiation and the row limits are the same; the *host* is a car with
Android built in rather than a phone projecting to a screen. What this does not
exercise is the projection transport itself. That needs the DHU and the phone.

---

## Running the Desktop Head Unit here

Installed and working on this machine:

```sh
export ANDROID_HOME=/home/ken/android-toolchain/android-sdk
cd "$ANDROID_HOME/extras/google/auto"
LD_LIBRARY_PATH=/home/ken/android-toolchain/dhu-libs/lib ./desktop-head-unit --help
# Android Auto - Desktop Head Unit
#   Build: 2022-03-30-438482292
#   Version: 2.0-linux
```

The `LD_LIBRARY_PATH` is not optional and not documented anywhere obvious: the
DHU 2.x binary needs `libc++.so.1`, `libc++abi.so.1` and `libunwind.so.1`, which
Debian trixie does not ship by default. There is no root on this box, so they
were fetched with `apt-get download` and extracted, not installed:

```sh
mkdir -p ~/android-toolchain/dhu-libs && cd ~/android-toolchain/dhu-libs
apt-get download libc++1-19 libc++abi1-19 libunwind-19
for d in *.deb; do dpkg-deb -x "$d" ./extract; done
mkdir -p lib
cp -L extract/usr/lib/llvm-19/lib/libc++.so.1.0     lib/libc++.so.1
cp -L extract/usr/lib/llvm-19/lib/libc++abi.so.1.0  lib/libc++abi.so.1
cp -L extract/usr/lib/llvm-19/lib/libunwind.so.1.0  lib/libunwind.so.1
```

There is no display on this box either, and the DHU wants one even under
`--headless` (`SDL_CreateWindowRenderer failed`). Xvfb is not installed and
hardcodes `/usr/bin/xkbcomp`, which is not writable without root. The way
through, which does not install or change anything system-wide:

```sh
# Xvfb, extracted the same way, plus its xkb pieces
apt-get download xvfb libunwind8 libxfont2 x11-xkb-utils xkb-data
# ...then run it with an overlayfs over /usr/bin inside a user namespace, so
# /usr/bin/xkbcomp exists only for that process tree:
unshare --map-root-user --mount sh -c '
  mount -t overlay overlay -o lowerdir=/usr/bin,upperdir=$R/upper,workdir=$R/work /usr/bin
  exec Xvfb :77 -screen 0 1280x800x24 -nolisten tcp -xkbdir .../xkb'
```

The X socket lands in the shared `/tmp/.X11-unix`, so it is reachable from
outside the namespace. That matters, because **the DHU refuses to run inside the
namespace** — as uid 0 it exits 0 with no output at all. So Xvfb runs inside and
the DHU runs outside against the same `:77`.

Once the phone is ready, this side is two commands:

```sh
adb forward tcp:5277 tcp:5277
cd "$ANDROID_HOME/extras/google/auto" && \
  LD_LIBRARY_PATH=/home/ken/android-toolchain/dhu-libs/lib DISPLAY=:77 \
  SDL_AUDIODRIVER=dummy ./desktop-head-unit --adb=5277
```

### How far this actually got, and where it stopped

Against a real Pixel 10 Pro (Android 17, Android Auto 17.5) over wireless adb,
with the head unit server started and "Add new cars to Android Auto" on:

| Step | Result |
|---|---|
| `adb connect` to the phone | ok |
| app installed on the phone | ok |
| phone listening on 5277 (`0x149D`) | ok |
| raw socket through the forward | ok — connects, phone waits for the DHU to speak |
| phone registers the car app | ok — `MuxtermCarAppService` resolves with the IOT category |
| DHU links to the head unit server | ok — `connected.` |
| protocol negotiated | ok — `Phone reported protocol version 1.7` |
| TLS established and certificate verified | ok — `SSL negotiation finished successfully`, `Verify returned: ok` |
| **projection session starts** | **no — `PROJECTION_NOT_STARTED`** |

Every software precondition is met. Unknown sources on, "Add new cars to Android
Auto" on, head unit server restarted immediately before connecting, protocol
versions agreeing, TLS verified. It still does not project, and the phone says
why in its own words:

```
CAR.SERVICE.LITE:      Car connection state changed: DISCONNECTING->DISCONNECTED
CAR.SERVICE.LITE:      stopped foreground service
CAR.SERVICE.LITE:      Detected charge only
CAR.SERVICE.FCD.LITE:  timed out at stage FIRST_ACTIVITY_LAUNCHED after 5000
                       milliseconds, publishing PROJECTION_NOT_STARTED
CAR.SERVICE.USBMON.LITE: Stopped USB monitor
```

and the DHU's side of the same second:

```
Starting link. Requested protocol version: 1.7
[I]: Connecting over ADB to localhost:5277...
[I]: connected.
Phone reported protocol version 1.7
ssl state=SSL negotiation finished successfully 1
SSL version=TLSv1.2 Cipher name=ECDHE-RSA-AES128-GCM-SHA256
Verify returned: ok
[E]: Failed to read from transport - disconnect. Exiting...
```

**"Detected charge only" is the answer.** Android Auto runs a USB monitor
(`CAR.SERVICE.USBMON.LITE`) and gates projection on a real USB *data* attachment,
independently of which transport carries the protocol. The adb tunnel carries it
fine — protocol agreed, TLS verified — and then the phone tears the session down
because, as far as its USB monitor is concerned, nothing is plugged in. Which is
true: this was wireless adb, over Tailscale, with the phone never physically
connected to this machine.

That is exactly what step 5 of the DHU procedure has been saying all along, and
it is not optional: *"Connect the mobile device to the development machine using
USB."*

**This machine cannot satisfy that.** It is an LXC container with no USB
subsystem exposed — `/dev/bus/usb` does not exist, and the only device visible in
sysfs is a YubiKey with no accessible device node. No cable changes that. Running
the DHU here needs either USB passthrough into the container, or the DHU run on a
machine that has the phone physically attached.

Ruled OUT along the way, so nobody re-tests them: version skew (both ends
negotiated 1.7), TLS or certificate trust (verified ok), the app not being
registered (`MuxtermCarAppService` resolves on the phone with the IOT category),
unknown sources, "add new cars", and a stale head unit server. The server restart
is what moved the failure from a silent "Waiting for phone…" to this precise,
diagnosable one — worth doing before any future attempt.

**This is not on the critical path.** What the DHU would add is the projection
transport; the screen itself is already proven against the same templates host
above. And per the blocking finding at the top of this file, the DHU cannot make
a sideloaded build work in a real vehicle either way — only an Internal App
Sharing upload does that.
