# Changelog

All notable changes to `@packstub/calls` are documented in this file.

## Unreleased

First release of `@packstub/calls`: the browser side of WebRTC calls, 1-on-1 and in small groups, as plain ES modules with no dependencies and no build step. It powers both Calls for Laravel and Filament Calls.

- `CallClient`: ring, invite, answer and hang up, with mute, camera off and screen share
- Calls survive a page load and can move to a pop-out window and back
- `HttpSignaling` for a polled HTTP backend, and a documented interface for your own
- Data channels and calls without media, plus room for an SFU through the `topology` option
- `CallWidget` (`@packstub/calls/widget`): a ready call UI for any page, restyled with CSS custom properties
- The microphone and camera turn off again when a call ends while `startMedia()` is still asking for them
- Polls back off while the server or the network is down (up to 5 seconds during a call, a minute otherwise) instead of retrying at full speed
- A page returned in place of JSON (a login form behind a redirect) is an error, no longer read as "no call", which ended the call
- After a page load mid-call, a browser that blocks sound until a click shows the video muted and turns the sound on with the first click, instead of a frozen tile
- The widget only shows avatars from http(s), relative, `blob:` or `data:image/` URLs, and falls back to initials for anything else
