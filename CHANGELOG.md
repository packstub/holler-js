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
- Widget accessibility: every icon button has a name, the incoming call and notices are read out by screen readers, focus stays in the call after Accept, and the ringing pulse respects reduced motion
- No screen share button in browsers that cannot share a screen (phones)
- A pop-out reloaded mid-call continues the right call when an earlier call's id started with the same digits
- A call recovers from a network change (Wi-Fi to mobile data): ICE restarts after 3 seconds disconnected instead of waiting for the browser to call the connection failed
- `escape()` is exported from the widget module for templates of your own, and the README says which values come from the server
- Each call starts with the media the options ask for, also after the previous call turned the microphone or camera on with `startMedia()`
- Someone who reloads the page shows as their avatar, not a frozen picture, until their video is back
