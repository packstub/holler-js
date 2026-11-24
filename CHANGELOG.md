# Changelog

All notable changes to `@packstub/holler` are documented in this file.

## Unreleased

- `RelaySignaling`: one participant keeps polling and passes signaling on over data channels, so everyone connected to it stops polling; everyone polls again whenever that participant is away. Off unless you wrap your signaling in it, and it needs a backend that names the hub (README, "Relayed signaling")
- `client.deliver()` and `client.pollNow()` for a signaling adapter that is pushed to instead of polled
- Someone left alone in a call that rings again (a meeting that stays open) is no longer hung up as dropped after the reconnect timeout, and sees the call as calling instead of reconnecting

## 1.0.0 — 2026-11-18

First release of `@packstub/holler`: the browser side of WebRTC calls, 1-on-1 and in small groups, as plain ES modules with no dependencies, with a minified build in `dist/` for pages that load them without a bundler. It powers both Holler for Laravel and Filament Holler.

- `CallClient`: ring, invite, answer, hang up, mute, camera off, screen share, and hold a call to ring someone else, then swap back
- Calls survive a page load, a network change and a move to a pop-out window; someone coming back from hold gets as long as their camera prompt takes
- A call that cannot connect says why in the console: no TURN server, or a TURN server that refused the credentials or could not be reached
- A session that expires mid-call ends the call cleanly as `signed_out` instead of freezing it
- `CallWidget` (`@packstub/holler/widget`): a ready call UI with a People panel (who is on the call, and a search to add someone, who joins the stage once they answer), device settings, a resizable picture of yourself and a weak-connection badge, usable from the keyboard and a screen reader
- `HttpSignaling` for a polled HTTP backend, data channels, calls without media, an SFU through the `topology` option, and TypeScript declarations
