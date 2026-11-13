/**
 * @packstub/holler — CallWidget: the call UI for any page, no framework needed.
 *
 * One object draws everything a call needs on top of a CallClient: the incoming-call
 * toast, the call window (a tile per other participant, your own picture, mute, camera,
 * screen share, adding someone from a search box, putting the call on hold, settings for
 * the microphone, camera and speaker, hang up), the chip shown while a pop-out window runs
 * the call, the bar of a call on hold (resume, end), and short notices. A call that rings while the tab
 * is in the background shows in the tab's title and, once the person allowed it
 * (`enableNotifications()`, or the link in the settings), as a system notification. Any element with `data-holler-call="<user id>"` rings that person; pressed during a call,
 * it asks whether to add them to the call, put the call on hold and ring them, or end the call
 * and ring them (`duringCall: 'add'` adds them without asking).
 *
 *   import { CallWidget } from '@packstub/holler/widget'
 *   const widget = new CallWidget({ routes, csrf, iceServers, windowUrl })
 *
 * Three ways to make it yours, from light to deep:
 *   - CSS: every class is `holler-*`, the colours and sizes are custom properties on `.holler`
 *     (`--holler-bg`, `--holler-accent`…); keep `widget.css`, override a few variables, or
 *     write your own stylesheet against the class names.
 *   - Templates: `templates.incoming`, `chip`, `window`, `tile`, `person`, `held`, `prompt` and `notice` are functions
 *     from a view model to an HTML string, rendered once each time the view appears and
 *     then kept up to date through a few `data-holler-*` hooks (see `patch()`): `text`,
 *     `show`, `class`, `attr`, `src`, `video`, `action`, `ref`. Hand in your own markup with
 *     whichever hooks you keep; `labels` and `icons` are overridable the same way.
 *   - Subclass: `model()`, `tileModel()`, `render()` and the actions are methods.
 *
 * Events: every CallClient event is dispatched again on the widget's element as
 * `holler:<type>` (bubbling, so `document.addEventListener('holler:ended', …)` works; `holler:held` when the call on hold changes),
 * plus `holler:sharing` { peer, sharing, spotlight } when someone's screen takes the stage.
 *
 * The chosen microphone, camera and speaker are remembered in this browser (localStorage,
 * `storageKey`); nothing about them goes to the server.
 */

import { CallClient, HttpSignaling } from './index.js'

const ACTIVE_STATES = ['calling', 'connecting', 'active', 'reconnecting', 'waiting']

// How long after the last key the people search asks the server.
const SEARCH_DELAY = 200

// My own picture's width as a share of the stage, as the person last resized it (shared with Filament Holler's widget).
const SELF_SIZE_KEY = 'holler:self-size'
const SELF_MIN = 0.12
const SELF_MAX = 0.6

// A pop-out that stopped holding the call for this long is gone, not reloading: the main page takes the call back.
const TAKE_BACK_DELAY = 3000

// Where the chosen microphone, camera and speaker are remembered, per browser.
const DEVICES_KEY = 'holler:devices'

// How fast the tab's title alternates while a call rings in the background.
const TITLE_FLASH = 1000

// The one-time tokens a page leaves for the pop-out it opens, and how long one is good for.
const OPEN_TOKEN_KEY = 'holler:open:'
const OPEN_TOKEN_TTL = 60000

const svg = (paths) => `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true" class="holler-icon">${paths}</svg>`

/** Heroicons (MIT), outline, the few the widget needs. */
export const icons = {
    phone: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z" />'),
    phoneX: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M15.75 3.75 18 6m0 0 2.25 2.25M18 6l2.25-2.25M18 6l-2.25 2.25m1.5 13.5c-8.284 0-15-6.716-15-15V4.5A2.25 2.25 0 0 1 4.5 2.25h1.372c.516 0 .966.351 1.091.852l1.106 4.423c.11.44-.054.902-.417 1.173l-1.293.97a1.062 1.062 0 0 0-.38 1.21 12.035 12.035 0 0 0 7.143 7.143c.441.162.928-.004 1.21-.38l.97-1.293a1.125 1.125 0 0 1 1.173-.417l4.423 1.106c.5.125.852.575.852 1.091V19.5a2.25 2.25 0 0 1-2.25 2.25h-2.25Z" />'),
    microphone: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />'),
    camera: svg('<path stroke-linecap="round" stroke-linejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />'),
    cameraOff: svg('<path stroke-linecap="round" stroke-linejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M12 18.75H4.5a2.25 2.25 0 0 1-2.25-2.25V9m12.841 9.091L16.5 19.5m-1.409-1.409c.407-.407.659-.97.659-1.591v-9a2.25 2.25 0 0 0-2.25-2.25h-9c-.621 0-1.184.252-1.591.659m12.182 12.182L2.909 5.909M1.5 4.5l1.409 1.409" />'),
    screen: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25" />'),
    speakerOff: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M17.25 9.75 19.5 12m0 0 2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6 4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />'),
    settings: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />'),
    signal: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M9.348 14.652a3.75 3.75 0 0 1 0-5.304m5.304 0a3.75 3.75 0 0 1 0 5.304m-7.425 2.121a6.75 6.75 0 0 1 0-9.546m9.546 0a6.75 6.75 0 0 1 0 9.546M5.106 18.894c-3.808-3.807-3.808-9.98 0-13.788m13.788 0c3.808 3.807 3.808 9.98 0 13.788M12 12h.008v.008H12V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />'),
    userPlus: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M18 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0ZM3 19.235v-.11a6.375 6.375 0 0 1 12.75 0v.109A12.318 12.318 0 0 1 9.374 21c-2.331 0-4.512-.645-6.374-1.766Z" />'),
    pause: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25v13.5m-7.5-13.5v13.5" />'),
    play: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />'),
    window: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />'),
    microphoneOff: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" /><path stroke-linecap="round" d="m3 3 18 18" />'),
    users: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />'),
    close: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />'),
    resize: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />'),
}

/** The English texts; hand in your own for other languages (`:name` and `:count` are filled in). */
export const labels = {
    incoming: 'is calling you',
    calling: 'Calling…',
    connecting: 'Connecting…',
    reconnecting: 'Reconnecting…',
    open_window: 'Open the call window',
    window_closed: 'Call window closed',
    window_closed_continuing: 'The call window closed; the call continues here.',
    popup_blocked: 'Pop-ups are blocked here, so the call opens on this page.',
    peer_muted: 'Muted',
    you_muted: 'Your mic is off',
    peer_camera_off: 'Camera off',
    peer_sharing: 'Sharing their screen',
    accept: 'Accept',
    decline: 'Decline',
    hang_up: 'Hang up',
    mute: 'Mute',
    unmute: 'Unmute',
    camera_off: 'Turn camera off',
    camera_on: 'Turn camera on',
    share_screen: 'Share screen',
    stop_sharing: 'Stop sharing',
    you: 'You',
    inviting: 'Ringing :name…',
    call_full: 'This call is full.',
    peer_left: ':name left the call',
    peer_declined: ':name declined',
    peer_missed: ':name did not answer',
    peer_dropped: ':name lost the connection',
    and_more: '+:count',
    ended_declined: 'Call declined',
    ended_cancelled: 'Call cancelled',
    ended_missed: 'No answer',
    ended_hung_up: 'Call ended',
    ended_failed: 'Could not connect',
    ended_dropped: 'Connection lost',
    ended_busy: 'Busy',
    ended_signed_out: 'You were signed out. Sign in again to call.',
    no_media: 'Could not access your camera or microphone.',
    settings: 'Settings',
    microphone: 'Microphone',
    camera: 'Camera',
    speaker: 'Speaker',
    default_device: 'System default',
    device_failed: 'Could not switch to that device.',
    notify: 'Notify me about calls when this tab is in the background',
    quality_poor: 'Weak connection',
    add_person: 'Add someone',
    search_people: 'Search people…',
    no_people: 'Nobody found',
    already_on_call: 'Already on this call',
    on_call_title: 'You are on a call',
    add_to_call: 'Add to this call',
    hold_and_call: 'Hold this call and start a new one',
    end_and_call: 'End this call and start a new one',
    cancel: 'Cancel',
    hold: 'Put on hold',
    on_hold: 'On hold',
    resume: 'Resume',
    peer_on_hold: ':name put the call on hold',
    held_ended: 'The call on hold ended',
    people: 'People',
    in_call: 'In this call',
    close: 'Close',
    resize_self: 'Drag to resize your picture',
}

/** Text made safe to put into HTML: what a template of your own does with a name or anything else from the server. */
export const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))

/**
 * The default markup. Each function gets the view model (`model()` or `tileModel()`,
 * plus `labels` and `icons`) and returns the HTML rendered the first time the view
 * shows; from then on the `data-holler-*` hooks keep it current.
 */
export const templates = {
    incoming: (v) => `
        <div class="holler-card holler-incoming" role="alertdialog" data-holler-scope data-holler-attr="aria-label:incomingLabel">
            <div class="holler-person">
                <img class="holler-avatar" alt="" data-holler-src="peerAvatar" data-holler-show="hasAvatar">
                <span class="holler-avatar holler-avatar-initials" data-holler-text="initials" data-holler-show="!hasAvatar"></span>
                <div class="holler-who">
                    <div class="holler-name" data-holler-text="peerName"></div>
                    <div class="holler-dim">${escape(v.labels.incoming)} <span data-holler-show="hasOthers">· <span data-holler-text="othersLabel"></span></span></div>
                </div>
            </div>
            <div class="holler-actions">
                <button type="button" class="holler-btn holler-btn-danger" data-holler-action="decline" title="${escape(v.labels.decline)}" aria-label="${escape(v.labels.decline)}">${v.icons.phoneX}</button>
                <button type="button" class="holler-btn holler-btn-success holler-pulse" data-holler-action="accept" title="${escape(v.labels.accept)}" aria-label="${escape(v.labels.accept)}">${v.icons.phone}</button>
            </div>
        </div>`,

    chip: (v) => `
        <div class="holler-card holler-chip" data-holler-scope>
            <button type="button" class="holler-person holler-chip-open" data-holler-action="focusWindow" title="${escape(v.labels.open_window)}">
                <span class="holler-avatar holler-avatar-initials">${v.icons.window}</span>
                <span class="holler-who">
                    <span class="holler-name" data-holler-text="names"></span>
                    <span class="holler-dim" data-holler-text="status"></span>
                </span>
            </button>
            <button type="button" class="holler-btn holler-btn-danger" data-holler-action="hangUp" title="${escape(v.labels.hang_up)}" aria-label="${escape(v.labels.hang_up)}">${v.icons.phoneX}</button>
        </div>`,

    window: (v) => `
        <div class="holler-card holler-window" role="region" data-holler-scope data-holler-attr="aria-label:names">
            <div class="holler-header">
                <div class="holler-name" data-holler-text="names"></div>
                <div class="holler-dim" data-holler-text="status"></div>
            </div>
            <div class="holler-body">
            <div class="holler-stage" data-holler-ref="stage" data-holler-attr="data-spotlight:spotlight data-strip:strip">
                <div class="holler-grid" data-holler-ref="grid" data-holler-attr="data-count:count"></div>
                <div class="holler-ringing" data-holler-show="hasRinging" role="status"><span class="holler-ringing-dot"></span><span data-holler-text="ringingLabel"></span></div>
                <div class="holler-self" data-holler-self data-holler-attr="style:selfStyle">
                    <video autoplay playsinline muted class="holler-local" aria-label="${escape(v.labels.you)}" data-holler-video="localStream" data-holler-class="holler-mirror:mirror holler-hidden:hideLocal"></video>
                    <span class="holler-badge holler-badge-round holler-self-muted" data-holler-show="muted" title="${escape(v.labels.you_muted)}">${v.icons.microphoneOff}<span class="holler-sr-only">${escape(v.labels.you_muted)}</span></span>
                    <button type="button" class="holler-self-resize" data-holler-resize-self title="${escape(v.labels.resize_self)}" aria-label="${escape(v.labels.resize_self)}">${v.icons.resize}</button>
                </div>
            </div>
            <aside class="holler-side" data-holler-show="sideOpen" data-holler-attr="aria-label:sideTitle">
                <div class="holler-side-header">
                    <div class="holler-name" data-holler-text="sideTitle"></div>
                    <button type="button" class="holler-icon-btn" data-holler-action="closePanels" title="${escape(v.labels.close)}" aria-label="${escape(v.labels.close)}">${v.icons.close}</button>
                </div>
                <div class="holler-settings" data-holler-ref="settings" data-holler-show="settingsOpen">
                    <label class="holler-field" data-holler-show="hasMicrophones"><span>${escape(v.labels.microphone)}</span><select class="holler-select" data-holler-device="microphone"></select></label>
                    <label class="holler-field" data-holler-show="hasCameras"><span>${escape(v.labels.camera)}</span><select class="holler-select" data-holler-device="camera"></select></label>
                    <label class="holler-field" data-holler-show="hasSpeakers"><span>${escape(v.labels.speaker)}</span><select class="holler-select" data-holler-device="speaker"></select></label>
                    <button type="button" class="holler-link" data-holler-action="enableNotifications" data-holler-show="canNotify">${escape(v.labels.notify)}</button>
                </div>
                <div class="holler-people" data-holler-ref="people" data-holler-show="peopleOpen">
                    <div class="holler-section-title">${escape(v.labels.in_call)}</div>
                    <ul class="holler-members" data-holler-ref="members"></ul>
                    <div class="holler-invite" data-holler-show="canAdd">
                        <div class="holler-section-title">${escape(v.labels.add_person)}</div>
                        <input type="search" class="holler-input" data-holler-people-search autocomplete="off" placeholder="${escape(v.labels.search_people)}" aria-label="${escape(v.labels.search_people)}">
                        <div class="holler-people-list" data-holler-ref="peopleList"></div>
                        <div class="holler-dim" data-holler-show="noPeople">${escape(v.labels.no_people)}</div>
                    </div>
                </div>
            </aside>
            </div>
            <div class="holler-controls">
                <button type="button" class="holler-btn" data-holler-action="toggleMute" data-holler-class="holler-btn-off:muted" data-holler-attr="title:muteTitle aria-label:muteTitle">${v.icons.microphone}</button>
                <button type="button" class="holler-btn" data-holler-action="toggleCamera" data-holler-class="holler-btn-off:cameraOff" data-holler-attr="title:cameraTitle aria-label:cameraTitle">
                    <span data-holler-show="!cameraOff">${v.icons.camera}</span><span data-holler-show="cameraOff">${v.icons.cameraOff}</span>
                </button>
                <button type="button" class="holler-btn" data-holler-action="toggleShare" data-holler-show="canShare" data-holler-class="holler-btn-on:sharing" data-holler-attr="title:shareTitle aria-label:shareTitle">${v.icons.screen}</button>
                <button type="button" class="holler-btn" data-holler-action="togglePeople" data-holler-class="holler-btn-on:peopleOpen" data-holler-attr="aria-expanded:peopleExpanded" title="${escape(v.labels.people)}" aria-label="${escape(v.labels.people)}">${v.icons.users}</button>
                <button type="button" class="holler-btn" data-holler-action="hold" data-holler-show="canHold" title="${escape(v.labels.hold)}" aria-label="${escape(v.labels.hold)}">${v.icons.pause}</button>
                <button type="button" class="holler-btn" data-holler-action="toggleSettings" data-holler-show="canSettings" data-holler-class="holler-btn-on:settingsOpen" data-holler-attr="aria-expanded:settingsExpanded" title="${escape(v.labels.settings)}" aria-label="${escape(v.labels.settings)}">${v.icons.settings}</button>
                <button type="button" class="holler-btn holler-btn-danger holler-btn-wide" data-holler-action="hangUp" title="${escape(v.labels.hang_up)}" aria-label="${escape(v.labels.hang_up)}">${v.icons.phoneX}</button>
            </div>
        </div>`,

    tile: (v) => `
        <div class="holler-tile" data-holler-scope data-holler-attr="data-peer-id:id data-peer-status:status data-role:role data-quality:quality">
            <video autoplay playsinline class="holler-remote" data-holler-video="stream" data-holler-class="holler-hidden:!showVideo"></video>
            <div class="holler-placeholder" data-holler-show="!showVideo">
                <img class="holler-avatar holler-avatar-lg" alt="" data-holler-src="avatar" data-holler-show="hasAvatar">
                <span class="holler-avatar holler-avatar-lg holler-avatar-initials" data-holler-text="initials" data-holler-show="!hasAvatar"></span>
            </div>
            <div class="holler-tile-name" data-holler-show="showName">
                <span data-holler-text="name"></span>
                <span class="holler-dim" data-holler-show="ringing">${escape(v.labels.calling)}</span>
                <span class="holler-dim" data-holler-show="connecting">${escape(v.labels.connecting)}</span>
                <span class="holler-dim" data-holler-show="onHold">${escape(v.labels.on_hold)}</span>
            </div>
            <div class="holler-badges">
                <span class="holler-badge holler-badge-round" data-holler-show="muted" data-peer="muted" title="${escape(v.labels.peer_muted)}">${v.icons.microphoneOff}<span class="holler-sr-only">${escape(v.labels.peer_muted)}</span></span>
                <span class="holler-badge" data-holler-show="sharing" data-peer="sharing">${v.icons.screen} ${escape(v.labels.peer_sharing)}</span>
                <span class="holler-badge" data-holler-show="cameraOffBadge" data-peer="camera-off">${v.icons.cameraOff} ${escape(v.labels.peer_camera_off)}</span>
                <span class="holler-badge holler-badge-warn" data-holler-show="poor" data-peer="quality">${v.icons.signal} ${escape(v.labels.quality_poor)}</span>
            </div>
        </div>`,

    // One person the search found: a click adds them to the call (`data-holler-add`, set by the widget).
    person: (v) => `
        <button type="button" class="holler-person holler-person-option" data-holler-scope>
            <img class="holler-avatar holler-avatar-sm" alt="" data-holler-src="avatar" data-holler-show="hasAvatar">
            <span class="holler-avatar holler-avatar-sm holler-avatar-initials" data-holler-text="initials" data-holler-show="!hasAvatar"></span>
            <span class="holler-name" data-holler-text="name"></span>
            <span class="holler-person-call" aria-hidden="true">${v.icons.phone}</span>
        </button>`,

    // Someone on the call, in the People panel (me first, as "You").
    member: (v) => `
        <li class="holler-person holler-member" data-holler-scope>
            <img class="holler-avatar holler-avatar-sm" alt="" data-holler-src="avatar" data-holler-show="hasAvatar">
            <span class="holler-avatar holler-avatar-sm holler-avatar-initials" data-holler-text="initials" data-holler-show="!hasAvatar"></span>
            <span class="holler-who">
                <span class="holler-name" data-holler-text="name"></span>
                <span class="holler-dim" data-holler-text="detail"></span>
            </span>
            <span class="holler-member-muted" data-holler-show="muted" title="${escape(v.labels.peer_muted)}">${v.icons.microphoneOff}</span>
        </li>`,

    // The call I put on hold, whatever else is on the screen.
    held: (v) => `
        <div class="holler-card holler-chip holler-held" data-holler-scope>
            <span class="holler-person">
                <span class="holler-avatar holler-avatar-initials">${v.icons.pause}</span>
                <span class="holler-who">
                    <span class="holler-name" data-holler-text="heldNames"></span>
                    <span class="holler-dim">${escape(v.labels.on_hold)}</span>
                </span>
            </span>
            <button type="button" class="holler-btn holler-btn-success" data-holler-action="resumeHeld" title="${escape(v.labels.resume)}" aria-label="${escape(v.labels.resume)}">${v.icons.play}</button>
            <button type="button" class="holler-btn holler-btn-danger" data-holler-action="endHeld" title="${escape(v.labels.hang_up)}" aria-label="${escape(v.labels.hang_up)}">${v.icons.phoneX}</button>
        </div>`,

    // Call pressed during a call: what to do with the call I am on.
    prompt: (v) => `
        <div class="holler-card holler-prompt" role="dialog" aria-label="${escape(v.labels.on_call_title)}" data-holler-scope>
            <div class="holler-prompt-title">
                <div class="holler-name">${escape(v.labels.on_call_title)}</div>
                <div class="holler-dim" data-holler-text="promptName" data-holler-show="promptName"></div>
            </div>
            <button type="button" class="holler-option" data-holler-action="promptAdd" data-holler-show="promptCanAdd">${v.icons.userPlus}<span>${escape(v.labels.add_to_call)}</span></button>
            <button type="button" class="holler-option" data-holler-action="promptHold" data-holler-show="promptCanHold">${v.icons.pause}<span>${escape(v.labels.hold_and_call)}</span></button>
            <button type="button" class="holler-option" data-holler-action="promptEnd">${v.icons.phoneX}<span>${escape(v.labels.end_and_call)}</span></button>
            <button type="button" class="holler-option holler-option-quiet" data-holler-action="promptCancel"><span>${escape(v.labels.cancel)}</span></button>
        </div>`,

    // Read out through the widget's live region, which is there before the text changes (a live region added with its text is often not read).
    notice: () => '<div class="holler-card holler-notice" data-holler-scope data-holler-text="notice"></div>',
}

/**
 * Bring a rendered view in line with its model through the `data-holler-*` hooks, without
 * touching nested views (anything inside another `data-holler-scope`):
 *   data-holler-text="key"                   textContent
 *   data-holler-show="key" | "!key"          hidden unless truthy
 *   data-holler-class="name:key name2:!key"  classes toggled
 *   data-holler-attr="name:key name2:key2"   attributes set (null or false removes, true sets it empty)
 *   data-holler-src="key"                    src (removed when empty, or not an http(s), relative, blob: or data:image/ URL)
 *   data-holler-video="key"                  a MediaStream as srcObject, playing
 */
export function patch(root, model) {
    const read = (expr) => {
        const negated = expr.startsWith('!')
        const value = model[negated ? expr.slice(1) : expr]

        return negated ? ! value : value
    }
    const each = (attribute, apply) => {
        const elements = [...root.querySelectorAll(`[${attribute}]`)].filter((el) => el.closest('[data-holler-scope]') === root)
        if (root.hasAttribute(attribute)) elements.unshift(root)
        for (const el of elements) apply(el, el.getAttribute(attribute))
    }
    const pairs = (spec) => spec.split(/\s+/).filter(Boolean).map((pair) => pair.split(':'))

    each('data-holler-text', (el, key) => {
        const text = String(read(key) ?? '')
        if (el.textContent !== text) el.textContent = text
    })
    each('data-holler-show', (el, key) => { el.hidden = ! read(key) })
    each('data-holler-class', (el, spec) => { for (const [name, key] of pairs(spec)) el.classList.toggle(name, Boolean(read(key))) })
    each('data-holler-attr', (el, spec) => {
        for (const [name, key] of pairs(spec)) {
            const value = read(key)
            if (value === null || value === undefined || value === false) el.removeAttribute(name)
            else if (el.getAttribute(name) !== String(value === true ? '' : value)) el.setAttribute(name, value === true ? '' : value)
        }
    })
    each('data-holler-src', (el, key) => {
        // An SVG avatar is fine in an <img> (no scripts run there), not in an element of a custom template that would run them.
        const value = safeUrl(read(key), { svg: el.tagName === 'IMG' })
        if (! value) el.removeAttribute('src')
        else if (el.getAttribute('src') !== value) el.setAttribute('src', value)
    })
    each('data-holler-video', (el, key) => attachStream(el, read(key) ?? null))
}

/**
 * An image URL from the server (an avatar), or null for anything that is not one: http(s),
 * a relative path, `blob:` and `data:image/` pass (SVG data only with `svg`, for an <img>); `javascript:`
 * and other schemes do not.
 */
export function safeUrl(value, { svg = false } = {}) {
    if (typeof value !== 'string' || value.trim() === '') return null
    const text = value.trim()
    if (/^data:image\//i.test(text)) return /^data:image\/[a-z0-9.+-]+[;,]/i.test(text) && (svg || ! /^data:image\/svg/i.test(text)) ? text : null

    try {
        const { protocol } = new URL(text, globalThis.document?.baseURI ?? 'http://localhost/')

        return ['http:', 'https:', 'blob:'].includes(protocol) ? text : null
    } catch {
        return null
    }
}

/**
 * A stream on a <video>, once: setting the same stream again would restart playback. When the
 * browser refuses to play sound before the person has clicked anything (a page that reloaded
 * mid-call), the video plays muted and the sound comes on with the first click or key press.
 */
export function attachStream(video, stream) {
    if (video.srcObject === stream) return
    video.srcObject = stream
    if (stream) play(video)
}

function play(video) {
    let playing
    try { playing = video.play() } catch { return }

    playing?.catch?.((error) => {
        if (error?.name !== 'NotAllowedError' || video.__hollerWaiting) return
        const doc = video.ownerDocument
        video.__hollerWaiting = true
        // Muted playback is always allowed: the picture at least.
        const unmute = ! video.muted
        if (unmute) {
            video.muted = true
            try { video.play()?.catch?.(() => {}) } catch {}
        }

        const resume = () => {
            doc.removeEventListener('pointerdown', resume, true)
            doc.removeEventListener('keydown', resume, true)
            video.__hollerWaiting = false
            if (! video.srcObject) return
            if (unmute) video.muted = false
            play(video)
        }
        doc.addEventListener('pointerdown', resume, true)
        doc.addEventListener('keydown', resume, true)
    })
}

// A ring (two short beeps) for the callee, a ringback (one long tone) for the caller.
function ringer() {
    let context = null
    let timer = null

    const beep = (frequency, start, length) => {
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        oscillator.type = 'sine'
        oscillator.frequency.value = frequency
        gain.gain.setValueAtTime(0.0001, context.currentTime + start)
        gain.gain.exponentialRampToValueAtTime(0.15, context.currentTime + start + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + start + length)
        oscillator.connect(gain).connect(context.destination)
        oscillator.start(context.currentTime + start)
        oscillator.stop(context.currentTime + start + length + 0.05)
    }

    return {
        play(kind) {
            this.stop()
            try {
                context ??= new (globalThis.AudioContext || globalThis.webkitAudioContext)()
                context.resume().catch(() => {})
            } catch {
                return
            }
            const cycle = () => kind === 'ring' ? (beep(880, 0, 0.3), beep(880, 0.45, 0.3)) : beep(440, 0, 1.2)
            cycle()
            timer = setInterval(cycle, kind === 'ring' ? 2500 : 4000)
        },
        stop() {
            clearInterval(timer)
            timer = null
        },
        close() {
            this.stop()
            context?.close?.().catch?.(() => {})
            context = null
        },
    }
}

/** The pop-out by its name: `{ window, blank }`, blank when the lookup itself opened an empty one; null when blocked or not ours. */
function findWindow(features) {
    try {
        // The features shape only a window this opens; an existing pop-out keeps its own.
        const found = window.open('', 'holler', features)
        if (! found) return null
        if (found.location.href === 'about:blank') return { window: found, blank: true }
        return found.location.origin === location.origin ? { window: found, blank: false } : null
    } catch {
        return null
    }
}

/** Tokens nobody used (the window was blocked or closed before it read one): gone after their minute. */
function sweepTokens() {
    for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i)
        if (! key?.startsWith(OPEN_TOKEN_KEY)) continue
        try {
            if (Date.now() - JSON.parse(localStorage.getItem(key)).at > OPEN_TOKEN_TTL) localStorage.removeItem(key)
        } catch {
            localStorage.removeItem(key)
        }
    }
}

/** `:name` and the like in a label, taken literally (a `$` in someone's name stays a `$`). */
export function fill(label, values) {
    return Object.entries(values).reduce((text, [key, value]) => text.replace(`:${key}`, () => String(value)), String(label))
}

export class CallWidget extends EventTarget {
    /**
     * @param {object} options
     * @param {CallClient} [options.client]  your own client; otherwise one is made from the options below
     * @param {object} [options.signaling]  a signaling adapter; otherwise an HttpSignaling from `routes` and `csrf`
     * @param {object} [options.routes]  the HttpSignaling routes (`__ID__` where the call id goes)
     * @param {string} [options.csrf]  the CSRF token, sent as `X-CSRF-TOKEN` and with the leave beacon
     * @param {RTCIceServer[]} [options.iceServers]  fixed servers; without them the widget asks the `ice` route each time a call starts, when there is one
     * @param {boolean} [options.video]  calls start with the camera on
     * @param {{ idle: number, active: number }} [options.poll]  milliseconds between polls
     * @param {number} [options.reconnectTimeout]  milliseconds before a quiet call is dropped
     * @param {number} [options.maxParticipants]
     * @param {Element} [options.root]  where the widget mounts (document.body)
     * @param {string} [options.windowUrl]  the pop-out page, with `__ID__` for a call and `__USER__` for someone to ring; set it and calls open in a window of their own
     * @param {boolean} [options.popOut]  use the pop-out (true when `windowUrl` is set)
     * @param {boolean} [options.inPopOut]  this page IS the pop-out: the widget fills it and does what the page that opened it asked (`?call=` / `?callee=` with a one-time `open` token; a link without one only shows the call)
     * @param {{ call?: string|number, callee?: string }} [options.openedFor]  what the pop-out does on load (read from the URL and checked against the token by default)
     * @param {string} [options.windowFeatures]  window.open features for the pop-out
     * @param {string|null} [options.callSelector]  elements that ring someone on click; the user id is in `data-holler-call`, their name (for the question below) in `data-holler-name` (null: none)
     * @param {'ask'|'add'} [options.duringCall]  what a call element does while I am on a call: ask (add, hold and call, end and call), or add the person at once (`ask`)
     * @param {object} [options.labels]  texts to override
     * @param {object} [options.templates]  views to override: incoming, chip, window, tile, person, held, prompt, notice
     * @param {object} [options.icons]  SVG strings to override
     * @param {boolean} [options.startPolling]  start polling at once (true)
     * @param {string} [options.kind]  the kind of calls this widget draws (`call`); other packages' calls never reach it
     * @param {'all'|'relay'} [options.iceTransportPolicy]
     * @param {boolean} [options.devices]  the settings button in the call window, to choose the microphone, camera and speaker (true)
     * @param {boolean} [options.notifications]  show a call that rings while the tab is in the background in the tab's title, and as a system notification once allowed (true)
     * @param {string|null} [options.storageKey]  the localStorage key the chosen devices are remembered under (`holler:devices`; null: not remembered)
     */
    constructor(options = {}) {
        super()
        const {
            client = null, signaling = null, routes = null, csrf = null, iceServers = null, video = true, poll, reconnectTimeout, maxParticipants,
            root = document.body, windowUrl = null, inPopOut = false, popOut = windowUrl !== null, openedFor = null,
            windowFeatures = 'popup=yes,width=460,height=620', callSelector = '[data-holler-call]', startPolling = true,
            kind = 'call', iceTransportPolicy = 'all', devices = true, notifications = true, storageKey = DEVICES_KEY, duringCall = 'ask',
        } = options

        this.duringCall = duringCall === 'add' ? 'add' : 'ask'

        this.devicesEnabled = Boolean(devices)
        this.notifications = Boolean(notifications)
        this.storageKey = storageKey

        this.labels = { ...labels, ...(options.labels ?? {}) }
        this.templates = { ...templates, ...(options.templates ?? {}) }
        this.icons = { ...icons, ...(options.icons ?? {}) }
        this.inPopOut = Boolean(inPopOut)
        this.popOut = Boolean(popOut) && ! this.inPopOut
        this.windowUrl = windowUrl
        this.windowFeatures = windowFeatures
        this.callSelector = callSelector
        this.openedFor = openedFor ?? (this.inPopOut ? this.readOpenedFor() : null)

        // A client of our own is ours to take down in destroy(); one passed in belongs to the page.
        this.ownsClient = ! client
        const adapter = signaling ?? new HttpSignaling({
                routes,
                headers: csrf ? { 'X-CSRF-TOKEN': csrf, 'X-Requested-With': 'XMLHttpRequest' } : { 'X-Requested-With': 'XMLHttpRequest' },
                beaconFields: csrf ? { _token: csrf } : {},
                kind,
            })
        this.client = client ?? new CallClient({
            signaling: adapter,
            // Fresh servers (and short-lived TURN credentials) for every call when the backend hands them out.
            iceServers: iceServers ?? (adapter.configuration ? () => adapter.configuration().then((rtc) => rtc.iceServers) : []),
            iceTransportPolicy, video, poll, reconnectTimeout, maxParticipants,
            devices: this.loadDevices(),
            // A page that leaves calls to the pop-out never takes one over itself.
            resumes: ! this.popOut,
        })

        this.state = 'idle'
        this.call = null
        this.peers = []
        this.stagePeers = []
        this.ringingPeers = []
        this.muted = false
        this.cameraOff = false
        this.sharing = false
        this.strip = 'top'
        this.notice = null
        this.seconds = 0
        this.views = { incoming: null, chip: null, window: null, held: null, prompt: null, notice: null }
        // The call I put on hold, as the client last heard of it.
        this.heldCall = null
        // Call pressed during a call: who it was for, until the person chooses.
        this.prompt = null
        this.peopleOpen = false
        this.selfSize = this.loadSelfSize()
        this.people = []
        this.peopleLoaded = false
        this.peopleTimer = null
        this.peopleSearch = 0
        // Set while this widget resumes or ends the call on hold itself: no notice that it is gone.
        this.quietHeld = false
        this.popupWindow = null
        this.clock = null
        this.takeBackTimer = null
        this.noticeTimer = null
        this.takingBack = false
        this.resizeObserver = null
        this.ring = ringer()
        this.listeners = []
        this.clockSince = null
        this.closeTimer = null
        this.sharingPeers = new Map()
        this.settingsOpen = false
        this.deviceList = { microphones: [], cameras: [], speakers: [] }
        this.titleTimer = null
        this.titleBefore = null
        this.notification = null

        this.mount(root)
        this.listen()
        if (startPolling) this.start()
    }

    // ---- lifecycle -----------------------------------------------------------

    mount(root) {
        this.el = document.createElement('div')
        this.el.className = this.inPopOut ? 'holler holler-popup' : 'holler'
        this.slots = {}
        for (const name of ['incoming', 'prompt', 'held', 'chip', 'window', 'notice']) {
            const slot = document.createElement('div')
            slot.className = `holler-slot holler-slot-${name}`
            slot.hidden = true
            this.el.appendChild(slot)
            this.slots[name] = slot
        }
        // What a screen reader says: notices, and who is calling.
        this.live = document.createElement('div')
        this.live.className = 'holler-live'
        this.live.setAttribute('role', 'status')
        this.live.setAttribute('aria-live', 'polite')
        this.el.appendChild(this.live)
        this.el.addEventListener('click', (event) => {
            const button = event.target.closest('[data-holler-action]')
            if (button && this.el.contains(button)) this.act(button.getAttribute('data-holler-action'))

            const person = event.target.closest('[data-holler-add]')
            if (person && this.el.contains(person)) {
                // The panel stays open: the person shows up under "In this call" as Calling…,
                // and the search starts over for the next one.
                const input = this.views.window?.querySelector('[data-holler-people-search]')
                if (input) input.value = ''
                this.add(person.getAttribute('data-holler-add'))
            }
        })
        // The corner of my own picture: drag it to make the picture bigger or smaller, or use the arrow keys on it.
        this.el.addEventListener('pointerdown', (event) => {
            if (event.target.closest?.('[data-holler-resize-self]') && this.el.contains(event.target)) this.startSelfResize(event)
        })
        this.el.addEventListener('keydown', (event) => {
            if (! event.target.closest?.('[data-holler-resize-self]')) return
            const step = { ArrowUp: 0.04, ArrowLeft: 0.04, ArrowDown: -0.04, ArrowRight: -0.04 }[event.key]
            if (! step) return
            event.preventDefault()
            this.resizeSelf(step)
        })
        this.el.addEventListener('input', (event) => {
            if (event.target.hasAttribute?.('data-holler-people-search')) this.searchPeople(event.target.value)
        })
        this.el.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return
            if (this.prompt) this.promptCancel()
            else if (this.peopleOpen || this.settingsOpen) this.closePanels()
        })
        this.el.addEventListener('change', (event) => {
            const kind = event.target.getAttribute?.('data-holler-device')
            if (kind) this.setDevice(kind, event.target.value || null)
        })
        root.appendChild(this.el)
    }

    /** Begin: polling for calls, and what a pop-out was opened for. */
    start() {
        const client = this.client

        const opened = this.openedFor

        if (this.inPopOut && opened?.callee && opened.trusted) {
            client.start()
            client.callUser(String(opened.callee)).catch(() => {})
        } else if (this.inPopOut && opened?.call) {
            // Answered only when the page that opened this window asked; a link alone continues
            // a call I am already in, or shows the one ringing me, with Accept.
            client.resumeCall(opened.call, { answer: Boolean(opened.trusted) })
        } else {
            client.start()
        }
    }

    /** Take the widget down; a client it made itself lets go of the call and closes the camera too. */
    destroy() {
        for (const [target, type, handler] of this.listeners) target.removeEventListener(type, handler)
        this.listeners = []
        this.resizeObserver?.disconnect()
        this.stopClock()
        clearTimeout(this.takeBackTimer)
        clearTimeout(this.noticeTimer)
        clearTimeout(this.closeTimer)
        clearTimeout(this.peopleTimer)
        this.clearAlert()
        this.ring.close()
        if (this.ownsClient) this.client.destroy()
        else this.client.stop()
        this.el.remove()
    }

    on(target, type, handler) {
        target.addEventListener(type, handler)
        this.listeners.push([target, type, handler])
    }

    listen() {
        const client = this.client

        this.on(client, 'statechange', ({ detail: { state } }) => {
            this.state = state
            this.call = client.call
            this.sharing = client.sharing

            // A call came back to this pop-out (a resume) before it closed over the one that ended.
            if (ACTIVE_STATES.includes(state)) {
                clearTimeout(this.closeTimer)
                this.closeTimer = null
            }

            this.syncUrl()
            this.ring.stop()
            if (state !== 'ringing') this.clearAlert()
            if (! ACTIVE_STATES.includes(state)) this.settingsOpen = this.peopleOpen = false
            // The call the question was about is gone.
            if (! ACTIVE_STATES.includes(state) && state !== 'elsewhere') this.prompt = null
            if (state === 'ringing') this.ring.play('ring')
            if (state === 'calling') this.ring.play('ringback')

            if (state === 'active' || (state === 'elsewhere' && client.call?.status === 'active')) this.startClock()
            else if (! ['reconnecting', 'connecting', 'waiting'].includes(state)) this.stopClock()

            this.render()
        })
        this.on(client, 'incoming', ({ detail: { call } }) => {
            this.call = call
            this.render()
            this.announce(this.model().incomingLabel)
            this.alertIncoming()
        })
        this.on(client, 'update', ({ detail: { call } }) => {
            this.call = call
            // The chip's clock counts from the answer, not from the ringing.
            if (this.state === 'elsewhere' && call.status === 'active' && (! this.clock || (call.answered_at && this.clockSince === null))) {
                this.stopClock()
                this.startClock()
            }
            this.syncUrl()
            this.watchWindow()
            this.render()
        })
        this.on(client, 'localstream', () => {
            this.render()
            // The browser names the devices once the camera or the microphone is allowed.
            if (this.settingsOpen) this.refreshDevices()
        })
        this.on(client, 'devices', () => {
            this.saveDevices()
            if (this.settingsOpen) this.refreshDevices()
            else this.render()
        })
        this.on(client, 'peers', () => {
            this.render()
            this.refreshPeople()
        })
        this.on(client, 'remotestream', () => this.render())
        this.on(client, 'peerstate', ({ detail: { peer, sharing } }) => {
            this.render()
            // Only when a screen starts or stops: a mute is a peerstate too.
            if ((this.sharingPeers.get(peer.id) ?? false) === sharing) return
            this.sharingPeers.set(peer.id, sharing)
            this.emit('sharing', { peer, sharing, spotlight: this.spotlight })
        })
        this.on(client, 'peerleft', ({ detail: { peer, reason } }) => {
            this.sharingPeers.delete(peer.id)
            const label = this.labels[`peer_${reason}`]
            if (label && client.peers.length > 0) this.show(fill(label, { name: peer.name }))
        })
        this.on(client, 'peerheld', ({ detail: { peer, onHold } }) => {
            if (onHold) this.show(fill(this.labels.peer_on_hold, { name: peer.name }))
            else this.render()
        })
        this.on(client, 'held', ({ detail: { call } }) => {
            const before = this.heldCall
            this.heldCall = call
            // My side went down with the hold: whoever shared a screen starts over when I am back.
            if (call) this.sharingPeers.clear()
            // Gone, and not into a call again (resumed here or in another window of mine): the others ended it.
            // Looked at once the poll that said so is applied, which also names a call resumed elsewhere.
            if (before && ! call && ! this.quietHeld) {
                queueMicrotask(() => {
                    if (! this.heldCall && String(client.call?.id ?? '') !== String(before.id)) this.show(this.labels.held_ended)
                })
            }
            this.render()
        })
        this.on(client, 'ended', ({ detail: { reason } }) => {
            this.sharing = false
            clearTimeout(this.takeBackTimer)
            this.takeBackTimer = null
            this.sharingPeers.clear()
            this.show(this.labels[`ended_${reason}`] || this.labels.ended_hung_up)
            this.render()
            if (this.inPopOut) this.closeTimer = setTimeout(() => window.close(), 1500)
        })
        this.on(client, 'error', ({ detail: { error, media } }) => {
            // Signed out, or the session expired: nothing to say every few seconds, just stop.
            if (error?.status === 401 || error?.status === 419) {
                client.stop()
                return
            }
            console.warn('[holler]', error)
            if (media) this.show(this.labels.no_media)
            // The server's own words for a refusal it explains (not allowed, full); nothing raw from a crash.
            else if (error?.reason && error.status >= 400 && error.status < 500) this.show(error.message)
        })

        // Everything the client says, again on the page: `holler:statechange`, `holler:ended`…
        for (const type of ['statechange', 'incoming', 'update', 'localstream', 'remotestream', 'peers', 'peerjoined', 'peerleft', 'peerheld', 'peerstate', 'quality', 'devices', 'held', 'ended', 'error']) {
            this.on(client, type, ({ detail }) => this.emit(type, detail))
        }

        // Any button on the page that names a person, and a `holler:call` event with { user }.
        if (this.callSelector) {
            this.on(document, 'click', (event) => {
                const button = event.target.closest?.(this.callSelector)
                if (button) this.callUser(button.getAttribute('data-holler-call'), { name: button.getAttribute('data-holler-name') })
            })
        }
        this.on(window, 'holler:call', (event) => this.callUser(event.detail?.user, { name: event.detail?.name }))
        // A full page load: let go of the call so this or the next page can pick it up again.
        this.on(window, 'pagehide', () => client.leave())
        // Back on the tab: the title and the notification have done their job.
        this.on(document, 'visibilitychange', () => { if (! document.hidden) this.clearAlert() })
        this.on(window, 'focus', () => this.clearAlert())
    }

    emit(type, detail) {
        this.el.dispatchEvent(new CustomEvent(`holler:${type}`, { detail, bubbles: true }))
        this.dispatchEvent(new CustomEvent(type, { detail }))
    }

    // ---- actions -------------------------------------------------------------

    act(name) {
        const actions = {
            accept: 'accept', decline: 'decline', hangUp: 'hangUp', toggleMute: 'toggleMute', toggleCamera: 'toggleCamera', toggleShare: 'toggleShare', focusWindow: 'focusWindow', toggleSettings: 'toggleSettings', enableNotifications: 'enableNotifications',
            togglePeople: 'togglePeople', closePanels: 'closePanels', hold: 'hold', resumeHeld: 'resumeHeld', endHeld: 'endHeld', promptAdd: 'promptAdd', promptHold: 'promptHold', promptEnd: 'promptEnd', promptCancel: 'promptCancel',
        }
        if (actions[name]) this[actions[name]]()
    }

    /**
     * Ring someone. On a call already (here, or in my pop-out), ask what to do with it: add
     * them to it, put it on hold and ring them, or end it and ring them (`duringCall: 'add'`
     * adds them without asking). `name` is shown with the question when given.
     */
    callUser(user, { name = null } = {}) {
        if (! user) return

        if (this.inCall || this.state === 'elsewhere') {
            if (this.duringCall === 'add') return this.add(user)

            if (this.client.peers.some((peer) => String(peer.id) === String(user))) {
                this.show(this.labels.already_on_call)
                return
            }

            this.prompt = { user: String(user), name: name ? String(name) : null }
            this.settingsOpen = this.peopleOpen = false
            this.render()
            // A page that only watches the call (the pop-out runs it) polls slowly: ask now, so the
            // question offers what the call allows at this moment (a hold needs it to be running).
            this.client.schedule?.(0)
            this.views.prompt?.querySelector('[data-holler-action]:not([hidden])')?.focus()
            return
        }

        // The pop-out, or the page itself when the browser blocks the window.
        if (this.popOut && this.openWindow({ callee: user })) return
        if (this.popOut) this.show(this.labels.popup_blocked)

        return this.client.callUser(String(user)).catch(() => {})
    }

    accept() {
        if (this.popOut && this.call && this.openWindow({ call: this.call.id })) {
            this.client.handOff()
            return
        }
        if (this.popOut) this.show(this.labels.popup_blocked)

        return this.client.accept().catch(() => {})
    }

    decline() { return this.client.decline() }

    hangUp() { return this.client.hangUp() }

    /** Add someone to the call I am on; the server rings them and everyone on the call connects to them. */
    async add(user) {
        if (! this.client.canInvite()) {
            this.show(this.labels.call_full)
            return
        }

        try {
            const call = await this.client.invite(String(user))
            const peer = call.peers?.find((candidate) => String(candidate.id) === String(user))
            this.show(fill(this.labels.inviting, { name: peer?.name ?? '' }))
        } catch (error) {
            this.show(error?.full ? this.labels.call_full : (error?.message || this.labels.call_full))
        }
    }

    // ---- Call pressed during a call ------------------------------------------------

    /** Whoever the question was about, the question closed. */
    takePrompt() {
        const prompt = this.prompt
        this.prompt = null
        this.render()

        return prompt
    }

    promptCancel() { this.takePrompt() }

    promptAdd() {
        const prompt = this.takePrompt()

        return prompt ? this.add(prompt.user) : undefined
    }

    /** The call I am on waits (see `hold()`), and the person is rung. */
    async promptHold() {
        const prompt = this.takePrompt()
        if (! prompt || ! await this.hold()) return

        return this.callUser(prompt.user, prompt)
    }

    /** The call I am on ends, and the person is rung. */
    async promptEnd() {
        const prompt = this.takePrompt()
        if (! prompt) return
        await this.client.hangUp()

        return this.callUser(prompt.user, prompt)
    }

    // ---- on hold --------------------------------------------------------------------

    /** Put the call I am on on hold; resolves to whether it is. */
    async hold() {
        try {
            await this.client.hold()

            return true
        } catch (error) {
            // The server's own words (a call already on hold, the call ended meanwhile) came through `error`.
            if (! error?.status) this.show(error?.message ?? '')

            return false
        }
    }

    /** Back into the call on hold: here, or in the pop-out when calls open in one. A call I am on goes on hold instead. */
    async resumeHeld() {
        const held = this.heldCall
        if (! held || this.state === 'ringing') return

        this.quietHeld = true
        try {
            await this.client.resumeHeld()
        } catch (error) {
            if (error?.status === 410) this.show(this.labels.held_ended)

            return
        } finally {
            this.quietHeld = false
        }

        // A page that leaves calls to the pop-out: the window opens for the call (or the page takes it over when blocked).
        if (this.popOut && ! this.openWindow({ call: held.id })) this.show(this.labels.popup_blocked)
    }

    /** Hang up the call on hold without coming back to it. */
    async endHeld() {
        this.quietHeld = true
        try {
            await this.client.endHeld()
        } finally {
            this.quietHeld = false
        }
    }

    // ---- adding people ----------------------------------------------------------------

    /** Open or close the search box of the call window. */
    togglePeople() {
        if (this.peopleOpen) return this.closePeople()

        this.peopleOpen = true
        this.settingsOpen = false
        this.people = []
        this.peopleLoaded = false
        this.render()

        if (! this.canAddNow()) return

        const input = this.views.window?.querySelector('[data-holler-people-search]')
        if (input) {
            input.value = ''
            input.focus()
        }
        this.loadPeople('')
    }

    /** Whether one more person can be rung into the call from here. */
    canAddNow() {
        return this.inCall && this.client.canInvite() && Boolean(this.client.signaling?.people)
    }

    /** Close the People or the Settings panel, whichever is open. */
    closePanels() {
        this.settingsOpen = false
        this.closePeople()
    }

    // ---- my own picture ---------------------------------------------------------------

    /** My picture's width as a share of the stage, as resized last time in this browser (null: the stylesheet's). */
    loadSelfSize() {
        try {
            const size = Number(localStorage.getItem(SELF_SIZE_KEY))

            return size >= SELF_MIN && size <= SELF_MAX ? size : null
        } catch {
            return null
        }
    }

    setSelfSize(size, save = true) {
        this.selfSize = Math.min(SELF_MAX, Math.max(SELF_MIN, size))
        if (save) {
            try { localStorage.setItem(SELF_SIZE_KEY, String(this.selfSize)) } catch {}
        }
        this.render()
    }

    /** Dragging the corner towards the middle of the stage makes the picture bigger. */
    startSelfResize(event) {
        const stage = this.views.window?.querySelector('[data-holler-ref="stage"]')
        const self = stage?.querySelector('[data-holler-self]')
        if (! stage || ! self || event.button > 0) return
        event.preventDefault()

        const rtl = getComputedStyle(stage).direction === 'rtl'
        const startX = event.clientX
        const startWidth = self.getBoundingClientRect().width
        const stageWidth = stage.getBoundingClientRect().width || 1
        const move = (e) => this.setSelfSize((startWidth + (rtl ? e.clientX - startX : startX - e.clientX)) / stageWidth, false)
        const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            if (this.selfSize) this.setSelfSize(this.selfSize)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
    }

    /** From the keyboard: a step bigger (positive) or smaller. */
    resizeSelf(step) {
        const stage = this.views.window?.querySelector('[data-holler-ref="stage"]')
        const self = stage?.querySelector('[data-holler-self]')
        const width = stage?.getBoundingClientRect().width
        const current = this.selfSize ?? (self && width ? self.getBoundingClientRect().width / width : 0.28)
        this.setSelfSize(current + step)
    }

    /** Who is on the call, me first, redrawn only when it changed. */
    renderMembers() {
        const list = this.views.window?.querySelector('[data-holler-ref="members"]')
        if (! list) return

        const me = { id: '', name: this.labels.you, avatar: null, detail: '', muted: this.muted }
        const members = this.peopleOpen ? [me, ...this.peers.map((peer) => ({
            id: peer.id,
            name: peer.name,
            avatar: peer.avatar,
            muted: peer.muted,
            detail: peer.status === 'ringing' ? this.labels.calling : peer.status === 'on_hold' ? this.labels.on_hold : peer.status === 'joined' && ! peer.connected ? this.labels.connecting : '',
        }))] : []
        const signature = members.map((member) => `${member.id}|${member.name}|${member.avatar ?? ''}|${member.detail}|${member.muted}`).join('\n')
        if (list.__hollerMembers === signature) return
        list.__hollerMembers = signature

        list.replaceChildren(...members.map((member) => {
            const model = { ...member, labels: this.labels, icons: this.icons, initials: this.initials(member.name), hasAvatar: Boolean(safeUrl(member.avatar, { svg: true })) }
            const holder = document.createElement('ul')
            holder.innerHTML = this.templates.member(model)
            const item = holder.firstElementChild
            patch(item, model)

            return item
        }))
    }

    closePeople() {
        clearTimeout(this.peopleTimer)
        this.peopleSearch++
        this.peopleOpen = false
        this.render()
    }

    /**
     * Someone joined, declined, missed or left: who can be added changed, so the open search
     * asks again for what is typed (someone who did not answer is back in the list).
     */
    refreshPeople() {
        const roster = this.client.peers.map((peer) => `${peer.id}:${peer.status}`).join(',')
        if (roster === this.peopleRoster) return
        this.peopleRoster = roster
        if (! this.peopleOpen || ! this.canAddNow()) return

        const input = this.views.window?.querySelector('[data-holler-people-search]')
        this.searchPeople(input?.value ?? '')
    }

    /** What was typed, once the person pauses. */
    searchPeople(query) {
        clearTimeout(this.peopleTimer)
        this.peopleTimer = setTimeout(() => this.loadPeople(query), SEARCH_DELAY)
    }

    async loadPeople(query) {
        const search = ++this.peopleSearch
        let people = []
        try {
            people = await this.client.search(String(query ?? '').trim())
        } catch {
            // Nobody to show; the client said why through `error`.
        }
        // An answer to what was typed before the last key, or after the box closed.
        if (search !== this.peopleSearch || ! this.peopleOpen) return

        this.people = people
        this.peopleLoaded = true
        this.render()
    }

    /** The people found, redrawn only when they changed. */
    renderPeople() {
        const list = this.views.window?.querySelector('[data-holler-ref="peopleList"]')
        if (! list) return

        const signature = this.peopleOpen ? this.people.map((person) => `${person.id}|${person.name}|${person.avatar ?? ''}`).join('\n') : ''
        if (list.__hollerPeople === signature) return
        list.__hollerPeople = signature

        list.replaceChildren(...(this.peopleOpen ? this.people : []).map((person) => {
            const model = { ...person, labels: this.labels, icons: this.icons, initials: this.initials(person.name), hasAvatar: Boolean(safeUrl(person.avatar, { svg: true })) }
            const holder = document.createElement('div')
            holder.innerHTML = this.templates.person(model)
            const option = holder.firstElementChild
            option.setAttribute('data-holler-add', String(person.id))
            patch(option, model)

            return option
        }))
    }

    toggleMute() {
        this.muted = ! this.muted
        this.client.setMuted(this.muted)
        this.render()
    }

    toggleCamera() {
        this.cameraOff = ! this.cameraOff
        this.client.setCameraOff(this.cameraOff)
        this.render()
    }

    async toggleShare() {
        try {
            if (this.client.sharing) await this.client.stopSharing()
            else await this.client.shareScreen()
        } catch {
            // The person cancelled the picker.
        }
        this.sharing = this.client.sharing
        this.render()
    }

    // ---- devices --------------------------------------------------------------

    /** The devices chosen last time in this browser, for the client to start with. */
    loadDevices() {
        if (! this.storageKey) return {}
        try {
            const { microphone = null, camera = null, speaker = null } = JSON.parse(localStorage.getItem(this.storageKey) ?? '{}') ?? {}

            return { microphone, camera, speaker }
        } catch {
            return {}
        }
    }

    saveDevices() {
        if (! this.storageKey) return
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(this.client.selected))
        } catch {
            // No storage here (a private window): the choice lasts for this page.
        }
    }

    toggleSettings() {
        this.settingsOpen = ! this.settingsOpen
        if (this.settingsOpen) this.peopleOpen = false
        this.render()
        if (this.settingsOpen) this.refreshDevices()
    }

    /** Ask the browser what there is to choose from, and draw it. */
    async refreshDevices() {
        const { microphones, cameras, speakers } = await this.client.devices()
        this.deviceList = { microphones, cameras, speakers }
        this.render()
    }

    /** Choose a microphone, camera or speaker (null: the system default); remembered for the next call. */
    async setDevice(kind, id) {
        try {
            await this.client.setDevice(kind, id)
        } catch {
            this.show(this.labels.device_failed)
            this.refreshDevices()
        }
    }

    /** Whether this browser can send the sound to a speaker of the person's choosing. */
    get canPickSpeaker() {
        return typeof globalThis.HTMLMediaElement?.prototype?.setSinkId === 'function'
    }

    /** The options of each device menu, redrawn only when they changed (an open menu stays open). */
    renderDevices() {
        const selected = this.client.selected ?? {}
        const lists = { microphone: this.deviceList.microphones, camera: this.deviceList.cameras, speaker: this.deviceList.speakers }

        for (const select of this.views.window?.querySelectorAll('[data-holler-device]') ?? []) {
            const kind = select.getAttribute('data-holler-device')
            const devices = lists[kind] ?? []
            const signature = devices.map((device) => `${device.id}|${device.label}`).join('\n')

            if (select.__hollerDevices !== signature) {
                select.__hollerDevices = signature
                select.replaceChildren(new Option(this.labels.default_device, ''), ...devices.map((device, index) => new Option(device.label || `${this.labels[kind]} ${index + 1}`, device.id)))
            }

            // A chosen device that is not listed any more (unplugged) reads as the default, which is what plays.
            const value = devices.some((device) => device.id === selected[kind]) ? selected[kind] : ''
            if (select.value !== value) select.value = value
        }
    }

    /** Send the sound of every participant to the chosen speaker, where the browser can. */
    applySpeaker() {
        if (! this.canPickSpeaker) return
        const speaker = this.client.selected?.speaker ?? null

        for (const media of this.el.querySelectorAll('video, audio')) {
            if ((media.__hollerSpeaker ?? null) === speaker) continue
            media.__hollerSpeaker = speaker
            // An unknown id (the speaker was unplugged) leaves the sound where it was.
            try { media.setSinkId(speaker ?? '')?.catch?.(() => {}) } catch {}
        }
    }

    // ---- a call in the background -----------------------------------------------

    /** Whether the person can still be asked to allow system notifications. */
    get canNotify() {
        return this.notifications && typeof globalThis.Notification === 'function' && globalThis.Notification.permission === 'default'
    }

    /**
     * Ask the person to allow system notifications for incoming calls. Browsers only show
     * the question after a click, so call it from one: the link in the call's settings
     * does, and so can a button of your own. Resolves to `granted`, `denied` or `default`.
     */
    async enableNotifications() {
        if (typeof globalThis.Notification !== 'function') return 'denied'

        let permission = globalThis.Notification.permission
        if (permission === 'default') {
            try {
                // Safari once took a callback and returned nothing.
                permission = await new Promise((resolve) => {
                    const asked = globalThis.Notification.requestPermission(resolve)
                    asked?.then?.(resolve, () => resolve('default'))
                })
            } catch {
                permission = 'default'
            }
        }
        this.render()

        return permission
    }

    /** A call rings while this tab is in the background: say so in the tab's title and, when allowed, with a system notification. */
    alertIncoming() {
        if (! this.notifications || this.state !== 'ringing') return
        if (! document.hidden && (document.hasFocus?.() ?? true)) return

        const title = this.model().incomingLabel
        const call = this.call

        if (this.titleTimer === null) {
            this.titleBefore = document.title
            let on = false
            const flash = () => {
                on = ! on
                document.title = on ? title : this.titleBefore
            }
            flash()
            this.titleTimer = setInterval(flash, TITLE_FLASH)
        }

        if (typeof globalThis.Notification !== 'function' || globalThis.Notification.permission !== 'granted') return

        try {
            this.notification?.close()
            // One per call across every tab of mine that is open: the tag replaces, it does not stack.
            this.notification = new globalThis.Notification(title, {
                tag: `holler-call-${call?.id ?? ''}`,
                icon: safeUrl(call?.peer?.avatar, { svg: true }) ?? undefined,
                requireInteraction: true,
            })
            this.notification.onclick = () => {
                globalThis.focus?.()
                this.clearAlert()
            }
        } catch {
            // Android Chrome only notifies through a service worker: the title and the ring remain.
            this.notification = null
        }
    }

    clearAlert() {
        if (this.titleTimer !== null) {
            clearInterval(this.titleTimer)
            this.titleTimer = null
            document.title = this.titleBefore
            this.titleBefore = null
        }
        try { this.notification?.close() } catch {}
        this.notification = null
    }

    show(text) {
        this.notice = text
        this.announce(text)
        clearTimeout(this.noticeTimer)
        this.noticeTimer = setTimeout(() => { this.notice = null; this.render() }, 4000)
        this.render()
    }

    /** Say this to a screen reader (the live region), without showing anything. */
    announce(text) {
        this.live.textContent = ''
        // A new text node, even for the same words twice in a row, so it is read again.
        setTimeout(() => { this.live.textContent = text }, 50)
    }

    // ---- the pop-out ---------------------------------------------------------

    /** The pop-out was opened to ring someone: from then on its URL names the call, so a reload continues it instead of ringing again. */
    syncUrl() {
        const call = this.client.call
        // The `call` parameter itself: `?call=12` must not pass for call 1.
        if (this.inPopOut && call && this.windowUrl && new URLSearchParams(location.search).get('call') !== String(call.id)) {
            history.replaceState(null, '', this.urlFor({ call: call.id }))
        }
    }

    urlFor(params) {
        return this.windowUrl.replace('__ID__', encodeURIComponent(params.call ?? '')).replace('__USER__', encodeURIComponent(params.callee ?? ''))
    }

    /**
     * What this pop-out was opened for. `trusted` only when the page that opened it left
     * the matching one-time token in localStorage: a link someone sent cannot ring
     * anybody or answer a call by itself.
     */
    readOpenedFor() {
        const query = new URLSearchParams(location.search)
        const opened = { call: query.get('call') || null, callee: query.get('callee') || null, trusted: false }
        const token = query.get('open')

        if (token) {
            try {
                const key = `${OPEN_TOKEN_KEY}${token}`
                const asked = JSON.parse(localStorage.getItem(key) ?? 'null')
                localStorage.removeItem(key)
                opened.trusted = Boolean(asked) && Date.now() - asked.at < OPEN_TOKEN_TTL
                    && String(asked.call ?? '') === String(opened.call ?? '') && String(asked.callee ?? '') === String(opened.callee ?? '')
            } catch {
                opened.trusted = false
            }
        }

        return opened
    }

    /** Open the pop-out (in `into`, a blank window already open, when given); false when the browser blocked it (then the call stays on this page). */
    openWindow(params, into = null) {
        if (! this.windowUrl) return false

        const token = Math.random().toString(36).slice(2) + Date.now().toString(36)
        const key = `${OPEN_TOKEN_KEY}${token}`
        let url = this.urlFor(params)
        try {
            sweepTokens()
            localStorage.setItem(key, JSON.stringify({ call: params.call ?? null, callee: params.callee ?? null, at: Date.now() }))
            url += `${url.includes('?') ? '&' : '?'}open=${token}`
        } catch {
            // No storage: the pop-out shows the call and waits for a click.
        }

        if (into) {
            into.location.replace(url)
            this.popupWindow = into
        } else {
            this.popupWindow = window.open(url, 'holler', this.windowFeatures)
        }
        if (! this.popupWindow) {
            try { localStorage.removeItem(key) } catch {}
        }
        this.popupWindow?.focus()

        return this.popupWindow !== null
    }

    /** Bring the pop-out back; open it again if it was closed, or continue the call here when that is blocked. */
    focusWindow() {
        if (this.popupWindow && ! this.popupWindow.closed) {
            this.popupWindow.focus()
            return
        }

        // A closed handle: the window is gone, open it again. No handle (this page reloaded): the
        // pop-out may still be open, so look it up by name; opening it would reload it mid-call.
        // The lookup opens a blank window when there is none, which then takes the pop-out page.
        const found = this.popupWindow ? null : findWindow(this.windowFeatures)
        if (found && ! found.blank) {
            this.popupWindow = found.window
            found.window.focus()
        } else if (this.call && ! this.openWindow({ call: this.call.id }, found?.window)) {
            this.takeBack()
        }
    }

    /**
     * The pop-out let go of the call (closed, or never claimed it): after a moment, the call
     * continues on this page. A pop-out that is only reloading claims its side back within
     * that moment; a closed one is taken back at once.
     */
    watchWindow() {
        const orphaned = this.popOut && this.state === 'elsewhere' && this.call && ! this.call.claimed_elsewhere && this.call.status !== 'ended'

        if (! orphaned) {
            clearTimeout(this.takeBackTimer)
            this.takeBackTimer = null
            return
        }

        if (this.popupWindow?.closed) {
            this.takeBack()
            return
        }

        this.takeBackTimer ??= setTimeout(() => {
            this.takeBackTimer = null
            this.takeBack()
        }, TAKE_BACK_DELAY)
    }

    async takeBack() {
        clearTimeout(this.takeBackTimer)
        this.takeBackTimer = null
        if (this.takingBack) return

        this.takingBack = true
        try {
            if (await this.client.takeOver()) this.show(this.labels.window_closed_continuing)
        } finally {
            this.takingBack = false
        }
    }

    // ---- the view model --------------------------------------------------------

    get inCall() {
        return ACTIVE_STATES.includes(this.state)
    }

    /** Who is on the call with me, for the header and the chip. */
    get names() {
        const names = this.stagePeers.map((peer) => peer.name)

        return names.length ? names.join(', ') : (this.call?.peer?.name ?? '')
    }

    /** Who is on the call I put on hold. */
    get heldNames() {
        const peers = (this.heldCall?.peers ?? []).filter((peer) => ['ringing', 'joined', 'on_hold'].includes(peer.status ?? 'joined'))

        return peers.length ? peers.map((peer) => peer.name).join(', ') : (this.heldCall?.peer?.name ?? '')
    }

    /** The peer whose screen has the stage: the first one sharing with video coming in, or null. */
    get spotlight() {
        return this.stagePeers.find((peer) => peer.sharing && peer.hasVideo)?.id ?? null
    }

    get elapsed() {
        const m = Math.floor(this.seconds / 60)
        const s = this.seconds % 60

        return `${m}:${String(s).padStart(2, '0')}`
    }

    get status() {
        const labels = this.labels
        if (this.state === 'calling') return labels.calling
        if (this.state === 'connecting') return labels.connecting
        if (this.state === 'reconnecting') return labels.reconnecting
        // Everyone else stepped out; they are back when they resume.
        if (this.state === 'waiting') return labels.on_hold
        if (this.state === 'active') return this.elapsed
        if (this.state === 'elsewhere') {
            if (this.call?.claimed_elsewhere) return this.call?.status === 'active' ? this.elapsed : labels.calling
            return this.call?.status === 'ringing' ? labels.connecting : labels.window_closed
        }

        return ''
    }

    initials(name) {
        return String(name || '?').split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('')
    }

    /** What the templates and hooks of the incoming toast, the chip and the call window read. */
    model() {
        const peer = this.call?.peer ?? null
        const ringing = this.ringingPeers
        const others = Math.max(0, this.peers.length - 1)
        const spotlight = this.spotlight

        return {
            labels: this.labels,
            icons: this.icons,
            state: this.state,
            inCall: this.inCall,
            names: this.names,
            status: this.status,
            elapsed: this.elapsed,
            notice: this.notice,
            // The incoming toast
            peerName: peer?.name ?? '',
            incomingLabel: `${peer?.name ?? ''} ${this.labels.incoming}`.trim(),
            peerAvatar: peer?.avatar ?? null,
            hasAvatar: Boolean(safeUrl(peer?.avatar, { svg: true })),
            initials: this.initials(peer?.name),
            others,
            hasOthers: others > 0,
            othersLabel: fill(this.labels.and_more, { count: others }),
            // The call window
            muted: this.muted,
            cameraOff: this.cameraOff,
            sharing: this.sharing,
            // Phones (iOS Safari, Android) cannot share a screen: no button there.
            canShare: this.state === 'active' && typeof globalThis.navigator?.mediaDevices?.getDisplayMedia === 'function',
            mirror: ! this.sharing,
            hideLocal: this.cameraOff && ! this.sharing,
            localStream: this.client.localStream,
            count: this.stagePeers.length,
            spotlight,
            strip: spotlight ? (this.stagePeers.length > 1 ? this.strip : 'none') : null,
            // Someone added to the call: rung, but not on the stage until they answer.
            hasRinging: ringing.length > 0,
            ringingLabel: fill(this.labels.inviting, { name: ringing.map((p) => p.name).join(', ') }),
            muteTitle: this.muted ? this.labels.unmute : this.labels.mute,
            cameraTitle: this.cameraOff ? this.labels.camera_on : this.labels.camera_off,
            shareTitle: this.sharing ? this.labels.stop_sharing : this.labels.share_screen,
            // The settings
            canSettings: this.devicesEnabled || this.canNotify,
            settingsOpen: this.settingsOpen,
            settingsExpanded: String(this.settingsOpen),
            hasMicrophones: this.devicesEnabled && this.deviceList.microphones.length > 0,
            hasCameras: this.devicesEnabled && this.deviceList.cameras.length > 0,
            hasSpeakers: this.devicesEnabled && this.canPickSpeaker && this.deviceList.speakers.length > 0,
            canNotify: this.canNotify,
            // Adding someone, and the call on hold
            canAdd: this.canAddNow(),
            peopleOpen: this.peopleOpen,
            sideOpen: this.peopleOpen || this.settingsOpen,
            sideTitle: this.peopleOpen ? this.labels.people : this.labels.settings,
            selfStyle: this.selfSize ? `width: ${Math.round(this.selfSize * 1000) / 10}%` : null,
            peopleExpanded: String(this.peopleOpen),
            noPeople: this.peopleOpen && this.peopleLoaded && this.people.length === 0,
            canHold: this.inCall && this.client.canHold(),
            hasHeld: Boolean(this.heldCall),
            heldNames: this.heldNames,
            // Call pressed during a call
            promptName: this.prompt?.name ?? '',
            promptCanAdd: this.client.canInvite(),
            promptCanHold: this.client.canHold(),
        }
    }

    /** What a tile reads about its peer. */
    tileModel(peer, spotlight) {
        const showVideo = peer.hasVideo && (! peer.cameraOff || peer.sharing)

        return {
            labels: this.labels,
            icons: this.icons,
            ...peer,
            initials: this.initials(peer.name),
            hasAvatar: Boolean(safeUrl(peer.avatar, { svg: true })),
            ringing: peer.status === 'ringing',
            connecting: peer.status === 'joined' && ! peer.connected,
            onHold: peer.status === 'on_hold',
            showVideo,
            showName: this.stagePeers.length > 1 || peer.status !== 'joined',
            cameraOffBadge: peer.cameraOff && ! peer.sharing,
            poor: peer.connected && peer.quality === 'poor',
            role: spotlight ? (peer.id === spotlight ? 'spotlight' : 'strip') : null,
        }
    }

    // ---- rendering -------------------------------------------------------------

    /** Draw what the state calls for: one view per slot, created when it appears and patched after. */
    render() {
        this.peers = this.client.peers.map((peer) => ({ ...peer, hasVideo: (peer.stream?.getVideoTracks().length ?? 0) > 0 }))
        // The stage shows who answered; someone rung into a running call waits off it ("Ringing Ana…").
        // While nobody has answered yet (my own outgoing call) the people I am ringing are the stage.
        const answered = this.peers.filter((peer) => peer.status !== 'ringing')
        this.stagePeers = answered.length ? answered : this.peers
        this.ringingPeers = answered.length ? this.peers.filter((peer) => peer.status === 'ringing') : []
        const model = this.model()
        // A keyboard user who answered or hung up from a view that goes away keeps their place.
        const focused = this.el.contains(document.activeElement) ? document.activeElement : null

        this.toggleView('incoming', this.state === 'ringing', model)
        this.toggleView('prompt', Boolean(this.prompt), model)
        this.toggleView('held', Boolean(this.heldCall), model)
        this.toggleView('chip', this.state === 'elsewhere', model)
        this.toggleView('window', this.inCall, model)
        this.toggleView('notice', Boolean(this.notice), model)

        if (this.views.window) {
            this.renderTiles(model.spotlight)
            this.renderPeople()
            this.renderMembers()
            this.renderDevices()
            this.applySpeaker()
        }

        if (focused && ! focused.isConnected) {
            // The first control (mute, or the chip's open button), not hang up: an Enter too many must not end the call.
            const next = [...((this.views.window ?? this.views.chip)?.querySelectorAll('[data-holler-action]') ?? [])].find((control) => ! control.closest('[hidden]'))
            if (next) next.focus()
            else if (this.focusBefore?.isConnected) this.focusBefore.focus()
        }
        // Where focus goes back to once the call is over: wherever it was before the widget showed up.
        if (! this.el.contains(document.activeElement) && document.activeElement !== document.body) this.focusBefore = document.activeElement
    }

    toggleView(name, visible, model) {
        const slot = this.slots[name]

        if (visible && ! this.views[name]) {
            slot.innerHTML = this.templates[name](model)
            this.views[name] = slot.firstElementChild
            slot.hidden = false
            if (name === 'window') this.observeStage()
        } else if (! visible && this.views[name]) {
            if (name === 'window') this.resizeObserver?.disconnect()
            slot.innerHTML = ''
            slot.hidden = true
            this.views[name] = null
        }

        if (this.views[name]) patch(this.views[name], model)
    }

    /** One tile per other participant, in seat order, kept by peer id so a video keeps playing. */
    renderTiles(spotlight) {
        const grid = this.views.window.querySelector('[data-holler-ref="grid"]')
        if (! grid) return

        const kept = new Set()
        let previous = null

        for (const peer of this.stagePeers) {
            let tile = [...grid.children].find((child) => child.getAttribute('data-holler-peer') === String(peer.id)) ?? null
            const model = this.tileModel(peer, spotlight)

            if (! tile) {
                const holder = document.createElement('div')
                holder.innerHTML = this.templates.tile(model)
                tile = holder.firstElementChild
                tile.setAttribute('data-holler-peer', String(peer.id))
            }

            if (tile.previousElementSibling !== previous || tile.parentNode !== grid) {
                previous ? previous.after(tile) : grid.prepend(tile)
            }

            patch(tile, model)
            kept.add(tile)
            previous = tile
        }

        for (const tile of [...grid.children]) {
            if (! kept.has(tile)) tile.remove()
        }
    }

    /**
     * Which side the cameras go to while a screen has the stage: the one that leaves a
     * 16:9 screen the bigger picture. A strip on the right costs width, one on top height.
     */
    placeStrip(width, height) {
        if (! width || ! height) return
        const fit = (w, h) => Math.min(w, h * 16 / 9)
        const withRight = fit(width - Math.max(112, width * 0.22), height)
        const withTop = fit(width, height - Math.max(84, height * 0.22))
        const strip = withRight > withTop ? 'right' : 'top'

        if (strip !== this.strip) {
            this.strip = strip
            this.render()
        }
    }

    observeStage() {
        const stage = this.views.window?.querySelector('[data-holler-ref="stage"]')
        if (! stage || typeof ResizeObserver !== 'function') return

        this.resizeObserver?.disconnect()
        this.resizeObserver = new ResizeObserver(([entry]) => this.placeStrip(entry.contentRect.width, entry.contentRect.height))
        this.resizeObserver.observe(stage)
    }

    startClock() {
        if (this.clock) return
        this.clockSince = this.call?.answered_at ? Date.parse(this.call.answered_at) : null
        const since = this.clockSince ?? Date.now()
        this.seconds = Math.max(0, Math.floor((Date.now() - since) / 1000))
        this.clock = setInterval(() => { this.seconds++; this.render() }, 1000)
    }

    stopClock() {
        clearInterval(this.clock)
        this.clock = null
        this.clockSince = null
        this.seconds = 0
    }
}
