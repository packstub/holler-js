# Changelog

All notable changes to `@packstub/calls` are documented in this file.

## Unreleased

First release. The engine moved here from `packstub/filament-calls` (its `js/` folder), unchanged.

- `CallClient`: media and `RTCPeerConnection` with perfect negotiation (the callee polite), ordered ICE candidates, screen share by track replacement (a video track is added on a voice call), voice fallback when there is no camera, mute and camera off, a `reconnecting` state and a drop timeout, `resumes` for a window that leaves calls to a pop-out.
- Reconnecting after a page load: each window has a `tab` id and holds its side of a call through the poll; `leave()` frees it as the page unloads; a fresh page claims the side, sends `reset` and a new offer; signals carry a `session` id so leftovers from an old connection are ignored.
- `HttpSignaling`: the polling adapter over JSON routes (`__ID__` placeholder), extra headers for CSRF, a `leave` beacon with form fields.
- `state` signal and `peerstate` event: a side tells the other when it mutes, turns the camera off or shares the screen (`peerMuted`, `peerCameraOff`, `peerSharing`); what is on is announced again to a side that joins or comes back from a reload, and a side that resets its connection starts with everything off.
- `takeOver()`: a tab in the `elsewhere` state (its pop-out ran the call) continues the call itself once no window holds it, back to ringing when the pop-out closed before answering; a pop-out that is only reloading keeps its side, since the server's claim decides.
- A Vitest suite with fake WebRTC globals and an in-memory signaling server.
