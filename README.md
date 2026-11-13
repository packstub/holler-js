# @packstub/holler

WebRTC calls (audio, video, screen share) for the browser, 1-on-1 and small groups, with a pluggable signaling backend and a pluggable topology. The engine behind [Holler for Laravel](https://github.com/packstub/holler) and [Filament Holler](https://github.com/packstub/filament-holler): plain ES modules, no dependencies. The engine (`@packstub/holler`) has no DOM and no framework; [`CallWidget`](#the-widget) (`@packstub/holler/widget`) is a ready-made UI on top of it.

- `CallClient` owns the local media and the roster of a call: who is in, who is ringing, who muted, whose media flows. Perfect negotiation per pair (the lower seat offers), ICE candidates applied in order, screen share by track replacement, voice fallback when there is no camera, mute and camera off.
- `MeshTopology` is how media travels by default: a direct `RTCPeerConnection` to every other participant, so no server touches the media. Right for up to four people; the `topology` option takes an SFU or relay adapter for bigger rooms, and the client never knows the difference.
- A call survives a full page load: every window has a random `tab` id, a participant's side belongs to one window at a time, a fresh page claims the side, asks each peer for a new connection (`reset`) and offers again. Signals carry a session id so leftovers from an old connection are ignored.
- `HttpSignaling` is the signaling adapter that ships: plain JSON endpoints, polled. A websocket or any other transport implements the same methods.
- `CallWidget` draws the incoming toast, the call window, the chip and notices in plain DOM, with templates, labels and CSS custom properties to make it yours.

## Install

```bash
npm install @packstub/holler
```

TypeScript declarations ship with the package (`src/index.d.ts`, `src/widget.d.ts`), including the typed events of `CallClient`.

A bundler takes the source modules through the package exports and minifies them with the rest of your code. For a page without one, the package also carries a minified build, about 25 kB gzipped for the engine, the widget and the stylesheet together:

```html
<link rel="stylesheet" href="/vendor/holler/widget.css">
<script type="module">
    // dist/index.js, dist/widget.js and dist/widget.css, served from one folder: the widget imports ./index.js beside it
    import { CallWidget } from '/vendor/holler/widget.js'
</script>
```

## Use

```js
import { CallClient, HttpSignaling } from '@packstub/holler'

const client = new CallClient({
    signaling: new HttpSignaling({
        routes: {
            poll: '/calls/poll',
            store: '/calls',
            answer: '/calls/__ID__/answer',
            decline: '/calls/__ID__/decline',
            hangup: '/calls/__ID__/hangup',
            signal: '/calls/__ID__/signals',
            leave: '/calls/__ID__/leave',
            invite: '/calls/__ID__/invite',     // optional: adding people to a running call
            hold: '/calls/__ID__/hold',         // optional, with resume: putting a call on hold
            resume: '/calls/__ID__/resume',
            people: '/calls/people',            // optional: the search behind "Add someone"
            ice: '/calls/ice-servers',          // optional: ICE servers asked per call (configuration())
        },
        headers: { 'X-CSRF-TOKEN': token },
        beaconFields: { _token: token },
    }),
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    video: true,
    poll: { idle: 5000, active: 1000 },
    reconnectTimeout: 15000,
    maxParticipants: 4,
})

client.addEventListener('incoming', ({ detail: { call } }) => showToast(call.peer.name))
client.addEventListener('localstream', ({ detail: { stream } }) => (localVideo.srcObject = stream))
client.addEventListener('remotestream', ({ detail: { stream, peer } }) => (tileFor(peer.id).srcObject = stream))
client.addEventListener('peers', ({ detail: { peers } }) => renderGrid(peers))
client.addEventListener('statechange', ({ detail: { state } }) => render(state))
client.addEventListener('ended', ({ detail: { reason } }) => showNotice(reason))

client.start()                            // poll for incoming calls
await client.callUser(userId)             // ring someone
await client.callUser([anaId, mihaiId])   // or a group
await client.accept()                     // or answer the call that is ringing
await client.invite(danaId)               // add someone to the call, also from a tab whose pop-out runs it (canInvite() says whether one more fits)
client.setMuted(true)                     // everyone else hears about it (peerstate)
await client.shareScreen()
await client.setDevice('microphone', id)  // another microphone, camera or speaker (devices() lists them)
await client.takeOver()                   // a tab in `elsewhere` continues a call its pop-out let go of
await client.hangUp()                     // the others go on without you; the call ends once one person is left

window.addEventListener('pagehide', () => client.leave())
```

### Data channels and calls without media

A call can carry data next to (or instead of) audio and video: name the channels and listen for them. With `media: 'none'` nothing asks for the camera or the microphone; the channel itself starts the connection, and `startMedia('audio')` (or `'video'`) adds media later, renegotiating each connection.

```js
import { CallClient, drain } from '@packstub/holler'

const client = new CallClient({ signaling, media: 'none', channels: ['assist'] })

client.addEventListener('datachannel', ({ detail: { channel, peer } }) => {
    channel.addEventListener('message', ({ data }) => handle(peer, data))
})

await drain(channel)            // before each large message: waits while the browser's buffer is full
channel.send(JSON.stringify(message))
await client.startMedia('audio')
```

Both sides make each channel with an id agreed in advance (its place in `channels`, so every participant lists the same labels in the same order), so they pair up whichever side offers; both get `datachannel` once it is open. `media: 'none'` needs at least one channel. After either side reloads, the new connection opens them again. `client.channel(label, peerId)` returns the open one.

A 1-on-1 call needs none of the group pieces: `remoteVideo.srcObject = stream` on `remotestream` and `client.peer` for the one other person still work.

### States

`idle`, `calling`, `ringing`, `connecting`, `active`, `reconnecting`, `waiting` (everyone else in the call put it on hold), `elsewhere` (another window of the same person holds the call, for a tab that shows a chip while a pop-out runs the call).

A call is `active` while media flows from at least one peer whose window is alive, and `reconnecting` when it flows from none; it ends as `dropped` after `reconnectTimeout` in that state. A call whose media never flowed stays `connecting` for that long and ends as `failed` on both sides: the browsers found no path to each other, which on a strict NAT, a VPN or a corporate network means the call needs a TURN server among the `iceServers` (the client says so in the console when none is configured, and when a TURN server refused the credentials or could not be reached). A peer coming back from hold gets as long as their camera prompt takes: the clock starts once their new connection does. In a group a single peer who went quiet shows as not `alive` on the roster while the call stays `active` for everyone else.

**On hold.** `hold()` steps out of a running call without leaving it: this window closes its connections and the camera and goes back to `idle`, with the call kept as `heldCall` in every window of mine. The others stay on the call and see me with the status `on_hold`; someone left alone with people on hold is `waiting`, for as long as it takes. `resumeHeld()` comes back with a fresh connection, the way a page does after a reload, and puts the call I am in meanwhile on hold in its place. One call on hold at a time.

### Events

| Event | Detail | When |
| --- | --- | --- |
| `statechange` | `{ state }` | the state above changed |
| `incoming` | `{ call }` | someone is ringing you, also into a call already running |
| `update` | `{ call }` | the call's server state changed (`held`, `status`, `peers`) |
| `localstream` | `{ stream }` | your camera and microphone, or the screen while sharing |
| `remotestream` | `{ stream, peer }` | a peer's media (fires again as tracks arrive) |
| `peers` | `{ peers }` | the roster changed: someone joined, left, connected, went quiet, muted… (also `client.peers`) |
| `peerjoined` | `{ peer }` | a peer is in the call |
| `peerleft` | `{ peer, reason }` | a peer is gone: `left`, `declined`, `missed` (never answered) or `dropped` (away too long) |
| `peerstate` | `{ peer, muted, cameraOff, sharing }` | a peer muted, turned the camera off or started sharing the screen |
| `peerheld` | `{ peer, onHold }` | a peer put the call on hold, or is back |
| `held` | `{ call }` | the call I have on hold changed: put on hold, resumed, or ended meanwhile (`null`) |
| `datachannel` | `{ peer, channel, label }` | a data channel named in `channels` is open to a peer (again after either side reloads) |
| `quality` | `{ peer, quality, rtt, loss, jitter, relayed }` | the connection to a peer changed its word: `good`, `fair` (from 300 ms round trip or 3% of packets lost) or `poor` (from 600 ms or 8%); `relayed` when a TURN server carries it |
| `devices` | `{ selected }` | a microphone, camera or speaker was chosen, or one was plugged in or out (ask `devices()` again) |
| `ended` | `{ call, reason }` | `declined`, `cancelled`, `missed` (also when a call stopped ringing as you answered), `hung_up`, `failed` (never connected), `dropped` (connected, then lost), `busy` (the person you rang is on another call; `call` is null), `signed_out` (a poll was answered with 401 or 419: the session expired or the person signed out) |
| `error` | `{ error, media? }` | a request or media failure; `media: true` when the camera or microphone could not be opened |

A `peer` in an event, and each entry of `client.peers`, is `{ id, name, avatar, seat, status, alive, connected, quality, muted, cameraOff, sharing, stream }`: what the server says (`seat`, `status`, `alive`), what the peer told us (`muted`, `cameraOff`, `sharing`) and what the topology gives (`connected`, `quality`, `stream`). `client.peer`, `peerMuted`, `peerCameraOff`, `peerSharing` and `remoteStream` are the first peer's, for a 1-on-1 UI.

### Options

| Option | Default | What |
| --- | --- | --- |
| `signaling` | required | an object with the signaling interface below |
| `iceServers` | `[]` | passed to `RTCPeerConnection` as is; or a function asked each time a call starts, e.g. `() => signaling.configuration().then((rtc) => rtc.iceServers)` (route `ice` on `HttpSignaling`), so short-lived TURN credentials are fresh per call |
| `video` | `true` | start calls with the camera on (falls back to voice when there is none) |
| `poll` | `{ idle: 5000, active: 1000, hidden: 15000 }` | milliseconds between polls: idle, during a call, and idle in a hidden tab (it polls at once when shown again) |
| `media` | `'video'` (`'audio'` with `video: false`) | what a call starts with; `'none'` asks for no camera or microphone and connects over data channels only, until `startMedia()` |
| `channels` | `[]` | labels of ordered data channels to open to every peer, surfaced by `datachannel` |
| `iceTransportPolicy` | `'all'` | `'relay'` sends everything through your TURN server, so neither side learns the other's addresses |
| `reconnectTimeout` | `15000` | milliseconds every peer may be away before the call ends as `dropped` |
| `resumes` | `true` | take over a call of mine that no window holds; `false` for a tab that leaves calls to a pop-out |
| `maxParticipants` | `4` | people on one call, me included: `callUser()` refuses a longer list and `canInvite()` says when the call is full (the server keeps the hard limit) |
| `topology` | a `MeshTopology` per call | how media travels: a topology instance, a class, or `(call, client) => topology` to pick one per call from its `peers` |
| `getUserMedia` | `navigator.mediaDevices.getUserMedia` | override for tests or custom constraints |
| `devices` | `{}` | `{ microphone, camera, speaker }` device ids to start with (what the person chose last time); a device that is gone falls back to the system's own |
| `statsInterval` | `3000` | milliseconds between looks at each connection's quality; `0` turns it off (`measure()` still works) |

### Methods and properties

| Method | Does |
| --- | --- |
| `start()` / `stop()` | begin and stop polling (`start()` also polls at once when a hidden tab is shown again) |
| `callUser(id \| ids)` | ring one person or a group |
| `accept()` / `decline()` | answer or refuse the call that rings |
| `invite(id)`, `canInvite()` | add someone to the running call; whether one more fits |
| `search(words)` | who can be added to the call (or rung, without one) for what was typed: `[{ id, name, avatar }]` |
| `hold()`, `canHold()` | step out of the running call without leaving it: the others stay and see me on hold, this window is free for another call |
| `resumeHeld()`, `endHeld()`, `heldCall` | back into the call on hold (a call I am in goes on hold instead, a swap), or hang it up; the call itself, from any window of mine |
| `hangUp()` | leave the call (it goes on for the others) |
| `setMuted(bool)`, `setCameraOff(bool)` | tell everyone else as well (`peerstate`) |
| `shareScreen()`, `stopSharing()` | the screen in place of the camera, and back |
| `startMedia('audio' \| 'video')` | add media to a call that started with less, renegotiating every connection |
| `devices()` | resolves to `{ microphones, cameras, speakers, selected }`, each device `{ id, label }`; labels are empty until the person allowed the camera or microphone, `speakers` is empty where the browser cannot pick one |
| `setDevice('microphone' \| 'camera' \| 'speaker', id)` | choose a device (`null`: the system default); during a call the track is swapped in place for everyone, without renegotiating. A speaker is only remembered (`client.selected.speaker`): the page plays the sound, so it calls `element.setSinkId(id)`, as the widget does |
| `measure()` | measure every connection now: `[{ peer, rtt, loss, jitter, relayed, quality }]` |
| `channel(label, peerId?)` | the open data channel to a peer (the first peer by default), or null |
| `resumeCall(callId?, { answer })` | pick up a call of mine on this page: the one named (answering it when `answer` is set), or whatever the server still has me in; for a pop-out window |
| `handOff()` | this window steps back to `elsewhere` while another window (a pop-out) answers or continues the call |
| `takeOver()` | a window in `elsewhere` continues a call nobody holds any more (its pop-out closed) |
| `leave()` | the `leave` beacon, for `pagehide` |
| `destroy()` | stop polling, let go of the call and close the connections and the camera, without events |

Properties: `state`, `call` (the server's call), `peers` and `peer`, `localStream`, `cameraStream` (the camera and microphone as asked for), `screenStream` (the shared screen, or null), `muted`, `cameraOff`, `sharing`, `tab` (this window's id), `selected` (the chosen devices), `quality` (the worst connection among the peers, or null), and `peerMuted`, `peerCameraOff`, `peerSharing`, `remoteStream` for the first peer.

Polls that fail (the server down, the network gone) are reported as `error` and the next one waits longer, doubling each time, up to 5 seconds during a call and a minute otherwise; the first poll that works brings the normal pace back. `HttpSignaling` rejects a page returned in place of JSON (a login form behind a redirect) with `reason: 'invalid_response'`.

## Topologies

A topology owns the connections; the client owns everything else (media, roster, signaling, states). `MeshTopology` ships: one `RTCPeerConnection` per peer, each participant uploads one copy of its media per peer, which is what makes four the sensible ceiling. For bigger rooms, an SFU or a relay adapter implements the same interface, and it can be chosen per call:

```js
import { CallClient, MeshTopology } from '@packstub/holler'

new CallClient({
    maxParticipants: 20,
    topology: (call) => call.peers.length > 3 ? new MySfuTopology({ url: sfuUrl }) : new MeshTopology(),
})
```

The interface (`attach`, `connect`, `disconnect`, `signal`, `connected` and `leave` are required, the rest optional):

```ts
attach(client)                        // once per call, before anything else
join(call)                            // I am in the call (open an uplink, say)
connect(peer, { polite, reset })      // start exchanging media with this peer; `polite` says who offers (the lower
                                      // seat does), `reset` after a page load: tell the peer to drop what it had of me
disconnect(peer)                      // the peer left
reset(peer, payload)                  // the peer is back on a fresh page and will offer again
stale(peer, payload)                  // a `state` signal from an old connection of theirs, to ignore
signal(peer, type, payload, from)     // offer | answer | ice, and anything the topology itself sends; `peer` is
                                      // null for a sender the roster does not know (an SFU, say)
connected(peer)                       // whether the peer's media flows
replaceVideo(track)                   // the screen in place of the camera (null: the camera is off, or voice only)
addTracks(stream)                     // media started mid-call (`startMedia()`): send these tracks too
channel(peer, label)                  // the open data channel with this label to the peer, or null
leave()                               // hang up: close everything
```

What the client offers a topology: `iceServers`, `iceTransportPolicy`, `channelLabels`, `seat`, `localSource()` (the stream whose tracks go out), `send(type, payload, to)` (a signal to one participant, or to all with `to` null), `remoteStreamFrom(peer, stream)`, `connectionChanged(peer, connected)`, `negotiated(peer)` (the client then tells the peer what I have on) and `emit('error', { error })`. A topology picked by a factory is made per call; an instance is reused and re-attached. Switching topology in the middle of a call is not supported: pick it from the size the call starts with, and let the server cap invites to match.

## The signaling interface

```ts
start(callees, tab)                  → call     // one user id, or an array of them for a group
answer(callId, tab)                  → call
decline(callId)                      → call
hangup(callId)                       → call
invite(callId, userId)               → call     // optional; add someone to a running call
hold(callId)                         → call     // optional, with resume; I step out of a running call without leaving it
resume(callId, tab)                  → call     // back into the call I put on hold; the call I am in goes on hold instead
people(query, callId)                → { people: [{ id, name, avatar }] }   // optional; who can be rung, or added to that call
send(callId, type, payload, to)      → void     // offer | answer | ice | reset | state; `to` a user id, or null for every other participant
poll({ after, call, tab, hold, kind }) → { call, incoming, on_hold, signals, cursor }   // kind: only calls of that kind; on_hold: the call I put on hold, if any
leave(callId, tab)                   → void     // optional, a beacon as the page unloads
configuration()                      → { iceServers, iceTransportPolicy }   // optional, ICE servers asked per call
```

A failed request rejects with an `Error` carrying `status` and, from Holler for Laravel, `reason` (`busy`, `not_ringing`, `not_allowed`, `full`, `ended`, `too_large`): the two 409s (busy, no longer ringing) are told apart by it.

A `call` is `{ id, kind, status: 'ringing' | 'active' | 'ended', end_reason, role: 'caller' | 'callee', seat, joined, peers, answered_at, on_hold, claimed_elsewhere }` plus `peer`, `peer_claimed` and `peer_seen_ago` for the first peer. `peers` lists every other participant as `{ id, name, avatar, seat, status: 'ringing' | 'joined' | 'on_hold' | 'left' | 'declined' | 'missed' | 'dropped', claimed, seen_ago }`. `seat` is the order people were invited in (the caller has 0); between two participants the lower seat makes the offer. `joined` is whether I am in (false while the call rings me). `claimed_elsewhere` means another window of mine (a pop-out) has claimed my side; a peer's `claimed` that it has a live window on the call. `on_hold` means that person stepped out of the call with `hold()` and is still on it, without a window or media until they resume. `poll` returns the call I put on hold as `on_hold`, next to `call` and `incoming`; it is no window's `call` meanwhile.

A signal is `{ id, call, type, payload, from }`, `from` being the sender's user id. An `answer` payload names the `offer` it answers (the offerer's session), so an answer to an offer from before the offerer's page reloaded is ignored.

**A 1-on-1 backend** sends neither `peers`, `seat`, `joined` nor `from`, and ignores `to`: the client derives them (the caller has seat 0, the callee seat 1, the one peer is the sender), so a backend without groups works unchanged. `invite` and the route for it are optional; without them `canInvite()` is false. So are `hold` with `resume` (`canHold()` is false) and `people` (`search()` finds nobody).

`poll` is the one request every window repeats: with `hold` set it claims this user's side of the named call for `tab` (and is its heartbeat), and only the window that holds the side receives the signals. The server marks a side whose window stopped polling as free after a few seconds, so a reloaded page can take it. A call ends on the server once fewer than two people are left in it; someone who hangs up on a group leaves it for the others.

`HttpSignaling` maps these onto the routes above; `__ID__` in a route is replaced with the call id. Its options:

| Option | Default | What |
| --- | --- | --- |
| `routes` | required | `poll`, `store`, `answer`, `decline`, `hangup`, `signal`, and optionally `leave`, `invite`, `hold` with `resume`, `people` and `ice` (without one of the optional routes the matching method is left out) |
| `headers` | `{}` | sent with every request, e.g. `{ 'X-CSRF-TOKEN': token }` |
| `beaconFields` | `{}` | form fields sent with the `leave` beacon, e.g. `{ _token: token }` |
| `kind` | `null` | adds `kind=` to every poll, so only calls of that kind come back |
| `timeout` | `10000` | milliseconds before a request is given up, so one stalled poll or signal cannot stop the rest |
| `fetch` | `globalThis.fetch` | your own fetch |

`start` posts `{ callee, tab }` for one person and `{ callees, tab }` for a group; `send` adds `to` when set; `invite` posts `{ callee }`, `resume` posts `{ tab }`, `people` asks `?q=<words>&call=<id>`. [Holler for Laravel](https://github.com/packstub/holler) implements the server side; the README there documents the endpoints for other backends.

## The widget

`CallWidget` is the UI over `CallClient`, plain DOM, no framework: the incoming-call toast, the call window (a tile per other participant with their video or avatar, your own picture, mute, camera, screen share, Add someone with a search box, Put on hold, settings, hang up), the chip shown while a pop-out window runs the call, the bar of a call on hold (Resume, End) and notices. A shared screen takes the stage with the cameras in a strip on top or on the right, wherever it gets more room.

```js
import { CallWidget } from '@packstub/holler/widget'
import '@packstub/holler/widget.css'

const widget = new CallWidget({
    routes, csrf,                       // an HttpSignaling is made from these (or pass `signaling`, or a `client` of your own)
    iceServers, video, maxParticipants,
    windowUrl: '/calls/window?call=__ID__&callee=__USER__',  // set it and calls open in a window of their own
    labels: { incoming: 'te sună' },     // any of the texts
})
```

| Option | Default | What |
| --- | --- | --- |
| `routes`, `csrf` | | an `HttpSignaling` is made from these (CSRF as `X-CSRF-TOKEN` and with the `leave` beacon) |
| `signaling` / `client` | | your own signaling adapter, or a `CallClient` of your own (the widget then leaves it running on `destroy()`) |
| `iceServers` | the `ice` route | fixed servers; without them the widget asks the `ice` route each time a call starts |
| `video`, `poll`, `reconnectTimeout`, `maxParticipants`, `iceTransportPolicy` | as `CallClient` | passed on to the client |
| `kind` | `'call'` | the kind of calls this widget draws |
| `root` | `document.body` | where the widget mounts |
| `windowUrl` | `null` | the pop-out page, with `__ID__` for a call and `__USER__` for someone to ring; set it and calls open in a window of their own |
| `popOut` | `true` when `windowUrl` is set | use the pop-out |
| `inPopOut` | `false` | this page is the pop-out |
| `openedFor` | read from the URL | what the pop-out does on load, `{ call }` or `{ callee }` |
| `windowFeatures` | `'popup=yes,width=460,height=620'` | `window.open` features for the pop-out |
| `callSelector` | `'[data-holler-call]'` | elements that ring someone on click (`null`: none) |
| `duringCall` | `'ask'` | what a call element does while I am on a call: ask (add to this call, hold it and ring them, end it and ring them), or `'add'` them at once |
| `labels`, `templates`, `icons` | the exported `labels`, `templates`, `icons` | override any of them |
| `startPolling` | `true` | start at once; `false` to change things first and call `start()` yourself |
| `devices` | `true` | the settings button in the call window: microphone, camera and, where the browser can, speaker |
| `notifications` | `true` | a call that rings while the tab is in the background shows in the tab's title, and as a system notification once the person allowed it |
| `storageKey` | `'holler:devices'` | the `localStorage` key the chosen devices are remembered under, per browser (`null`: not remembered) |

Any element with `data-holler-call="<user id>"` rings that person, and so does a `holler:call` event on `window` with `{ user }`. Pressed during a call, it asks what to do with the call you are on: add the person to it, put it on hold and ring them, or end it and ring them (a `data-holler-name` attribute, or `name` in the event, shows who the question is about). The Add someone button needs the `people` route and Put on hold the `hold` and `resume` routes; without them the buttons stay out. `widget.callUser(id)`, `accept()`, `decline()`, `hangUp()`, `add(id)`, `hold()`, `resumeHeld()`, `endHeld()`, `toggleMute()`, `toggleCamera()`, `toggleShare()` and `show(text)` do the same from a script (`announce(text)` only tells a screen reader). Every client event is dispatched again on the widget's element as `holler:<type>` (bubbling), plus `holler:sharing` `{ peer, sharing, spotlight }`. On the pop-out page itself, `inPopOut: true` makes the widget fill the window and do what the page that opened it asked: that page leaves a one-time token in `localStorage` and adds it to the URL (`&open=`), so a link alone never rings anyone or answers a call; it shows the call, with Accept. `destroy()` takes it all down: it stops polling, lets go of the call for the next page and closes the camera and the connections of the client it made. Signed out (401, 419) it stops polling quietly. `kind` (`call`) keeps other packages' calls away from the widget; `iceTransportPolicy` is passed on.

**Settings.** The cog in the call window opens the microphone, camera and speaker menus; a choice applies at once, for everyone on the call, and is remembered in this browser for the next call. A tile shows "Weak connection" while the connection to that person is `poor`.

**A call in the background.** While a call rings in a tab the person is not looking at, the tab's title alternates with "Ana is calling you". A system notification needs the person's permission, and browsers only ask after a click: the settings carry a link for it, and `widget.enableNotifications()` does the same from a button of your own (`widget.canNotify` says whether there is still something to ask). One notification per call, however many tabs are open; a click on it brings the tab back.

Three ways to make it yours:

- **CSS.** Every class is `holler-*`; the colours and sizes are custom properties on `.holler` (`--holler-bg`, `--holler-fg`, `--holler-dim`, `--holler-accent`, `--holler-danger`, `--holler-success`, `--holler-stage`, `--holler-radius`, `--holler-width`, `--holler-z`, `--holler-font`). Skip `widget.css` and write your own against the class names when that is not enough.
- **Templates.** `templates.incoming`, `chip`, `window`, `tile`, `person` (one result of the people search), `member` (someone on the call in the People panel), `held` (the bar of a call on hold), `prompt` (the question when Call is pressed during a call) and `notice` are functions from a view model to an HTML string, rendered once each time the view appears and then kept current through hooks: `data-holler-text="key"`, `data-holler-show="key"` (or `"!key"`), `data-holler-class="name:key …"`, `data-holler-attr="name:key …"`, `data-holler-src="key"`, `data-holler-video="key"` (a MediaStream) and `data-holler-action="accept|decline|hangUp|hold|resumeHeld|endHeld|togglePeople|closePanels|promptAdd|promptHold|promptEnd|promptCancel|toggleMute|toggleCamera|toggleShare|toggleSettings|enableNotifications|focusWindow"`; a `<select data-holler-device="microphone|camera|speaker">` is filled with the devices and switches on change. The root of a template carries `data-holler-scope`; the window's needs `data-holler-ref="grid"` for the tiles, `data-holler-ref="stage"` for the strip, `data-holler-ref="members"` and `data-holler-ref="peopleList"` for the People panel, and `data-holler-self` around your own picture with a `data-holler-resize-self` handle to resize it (the width is remembered in localStorage, `holler:self-size`). Pass `templates`, `labels` and `icons` to the constructor, or set them on the widget before `start()` (with `startPolling: false`). The model is what `model()` returns (`names`, `status`, `peerName`, `peerAvatar`, `hasAvatar`, `initials`, `others`, `hasOthers`, `othersLabel`, `muted`, `cameraOff`, `sharing`, `canShare`, `localStream`, `count`, `spotlight`, `strip`, `hasRinging` and `ringingLabel` (someone added and still ringing, who joins the stage once they answer), `notice`, the titles, `canSettings`, `settingsOpen`, `peopleOpen`, `sideOpen`, `sideTitle`, `canAdd`, `selfStyle`, `hasMicrophones`, `hasCameras`, `hasSpeakers`, `canNotify`, plus `labels` and `icons`) and, for a tile, `tileModel(peer)` (the peer's `id`, `name`, `avatar`, `status`, `connected`, `muted`, `cameraOff`, `sharing`, `stream`, `hasVideo`, plus `initials`, `hasAvatar`, `ringing`, `connecting`, `showVideo`, `showName`, `cameraOffBadge`, `poor`, `role`).
- **Subclass.** `model()`, `tileModel()`, `render()`, `renderTiles()`, `placeStrip()` and the actions are methods on `CallWidget`.

The module also exports `labels`, `templates` and `icons` (the defaults), `patch(root, model)` (applies the hooks to a piece of markup), `attachStream(video, stream)`, `fill(label, values)` (fills in `:name` and the like), `escape(text)` and `safeUrl(url)`, for templates and subclasses of your own.

Names and avatars come from the server and are whatever people typed. The default templates never put them into the HTML: they reach the page through the hooks (`data-holler-text` sets text, `data-holler-src` takes only http(s), relative, `blob:` and `data:image/` URLs). A template of your own that writes a value from the model into its HTML string must pass it through `escape()` first.

`CallClient` methods not documented here (`tick`, `schedule`, `interval`, `backoff`, `handlePoll`, `join`, `resume`, `ring`, `placeCall`, `answerCall`, `doTakeOver`…) are internal: they may change in any release.

## Testing

```bash
npm test
npm run test:types   # the README's examples compiled against the declarations
```

The suite runs in Node with fakes for `RTCPeerConnection`, `MediaStream` and the media devices, and an in-memory signaling server that follows the backend's rules (participants with seats, a side held by one window, addressed signals), so two or three clients talk to each other through it in a test.

## License

MIT, see [LICENSE.md](LICENSE.md).
