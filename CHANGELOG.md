# Changelog

All notable changes to `@packstub/calls` are documented in this file.

## Unreleased

First release of `@packstub/calls`: the browser side of WebRTC calls, 1-on-1 and in small groups, as plain ES modules with no dependencies and no build step. It powers both Calls for Laravel and Filament Calls.

- `CallClient`: ring, invite, answer and hang up, with mute, camera off and screen share
- Calls survive a page load, a network change (ICE restarts after a few seconds disconnected) and a move to a pop-out window and back
- `HttpSignaling` for a polled HTTP backend, backing off while the server is down, and a documented interface for your own
- Data channels and calls without media (`startMedia()` adds the microphone or camera later), plus room for an SFU through the `topology` option
- `CallWidget` (`@packstub/calls/widget`): a ready call UI for any page, restyled with CSS custom properties, usable from the keyboard and with a screen reader
- Names and avatars from the server never reach the page as HTML: text is set as text, avatars only from image URLs, and `escape()` for templates of your own
