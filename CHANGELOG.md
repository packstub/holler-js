# Changelog

All notable changes to `@packstub/holler` are documented in this file.

## Unreleased

First release of `@packstub/holler`: the browser side of WebRTC calls, 1-on-1 and in small groups, as plain ES modules with no dependencies, with a minified build in `dist/` for pages that load them without a bundler. It powers both Holler for Laravel and Filament Holler.

- `CallClient`: ring, invite, answer and hang up, with mute, camera off and screen share
- Calls survive a page load, a network change (ICE restarts after a few seconds disconnected) and a move to a pop-out window and back
- `HttpSignaling` for a polled HTTP backend, backing off while the server is down, and a documented interface for your own
- Data channels and calls without media (`startMedia()` adds the microphone or camera later), plus room for an SFU through the `topology` option
- Put a call on hold, ring someone else and swap back: the others stay on the call and see you on hold
- `CallWidget` (`@packstub/holler/widget`): a ready call UI for any page, restyled with CSS custom properties, usable from the keyboard and with a screen reader
- Choose the microphone, camera and speaker, also mid-call; the widget has a settings menu for it and remembers the choice
- An Add someone button with a search box in the call window, and a question when Call is pressed during a call: add, hold and call, or end and call
- A call ringing in a background tab shows in the tab's title and, once allowed, as a system notification
- Connection quality per person, a "Weak connection" badge in the widget, and `failed` for a call that never connects, with a pointer to TURN
- TypeScript declarations for the engine and the widget
- Names and avatars from the server never reach the page as HTML: text is set as text, avatars only from image URLs, and `escape()` for templates of your own
