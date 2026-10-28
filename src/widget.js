/**
 * @packstub/calls — CallWidget: the call UI for any page, no framework needed.
 *
 * One object draws everything a call needs on top of a CallClient: the incoming-call
 * toast, the call window (a tile per other participant, your own picture, mute, camera,
 * screen share, hang up), the chip shown while a pop-out window runs the call, and short
 * notices. Any element with `data-calls-call="<user id>"` rings that person, or adds them
 * to the call you are on.
 *
 *   import { CallWidget } from '@packstub/calls/widget'
 *   const widget = new CallWidget({ routes, csrf, iceServers, windowUrl })
 *
 * Three ways to make it yours, from light to deep:
 *   - CSS: every class is `calls-*`, the colours and sizes are custom properties on `.calls`
 *     (`--calls-bg`, `--calls-accent`…); keep `widget.css`, override a few variables, or
 *     write your own stylesheet against the class names.
 *   - Templates: `templates.incoming`, `chip`, `window`, `tile` and `notice` are functions
 *     from a view model to an HTML string, rendered once each time the view appears and
 *     then kept up to date through a few `data-calls-*` hooks (see `patch()`): `text`,
 *     `show`, `class`, `attr`, `src`, `video`, `action`, `ref`. Hand in your own markup with
 *     whichever hooks you keep; `labels` and `icons` are overridable the same way.
 *   - Subclass: `model()`, `tileModel()`, `render()` and the actions are methods.
 *
 * Events: every CallClient event is dispatched again on the widget's element as
 * `calls:<type>` (bubbling, so `document.addEventListener('calls:ended', …)` works),
 * plus `calls:sharing` { peer, sharing, spotlight } when someone's screen takes the stage.
 */

import { CallClient, HttpSignaling } from './index.js'

const ACTIVE_STATES = ['calling', 'connecting', 'active', 'reconnecting']

// A pop-out that stopped holding the call for this long is gone, not reloading: the main page takes the call back.
const TAKE_BACK_DELAY = 3000

// The one-time tokens a page leaves for the pop-out it opens, and how long one is good for.
const OPEN_TOKEN_KEY = 'packstub-calls:open:'
const OPEN_TOKEN_TTL = 60000

const svg = (paths) => `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true" class="calls-icon">${paths}</svg>`

/** Heroicons (MIT), outline, the few the widget needs. */
export const icons = {
    phone: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z" />'),
    phoneX: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M15.75 3.75 18 6m0 0 2.25 2.25M18 6l2.25-2.25M18 6l-2.25 2.25m1.5 13.5c-8.284 0-15-6.716-15-15V4.5A2.25 2.25 0 0 1 4.5 2.25h1.372c.516 0 .966.351 1.091.852l1.106 4.423c.11.44-.054.902-.417 1.173l-1.293.97a1.062 1.062 0 0 0-.38 1.21 12.035 12.035 0 0 0 7.143 7.143c.441.162.928-.004 1.21-.38l.97-1.293a1.125 1.125 0 0 1 1.173-.417l4.423 1.106c.5.125.852.575.852 1.091V19.5a2.25 2.25 0 0 1-2.25 2.25h-2.25Z" />'),
    microphone: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />'),
    camera: svg('<path stroke-linecap="round" stroke-linejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />'),
    cameraOff: svg('<path stroke-linecap="round" stroke-linejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M12 18.75H4.5a2.25 2.25 0 0 1-2.25-2.25V9m12.841 9.091L16.5 19.5m-1.409-1.409c.407-.407.659-.97.659-1.591v-9a2.25 2.25 0 0 0-2.25-2.25h-9c-.621 0-1.184.252-1.591.659m12.182 12.182L2.909 5.909M1.5 4.5l1.409 1.409" />'),
    screen: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25" />'),
    speakerOff: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M17.25 9.75 19.5 12m0 0 2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6 4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />'),
    window: svg('<path stroke-linecap="round" stroke-linejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />'),
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
    no_media: 'Could not access your camera or microphone.',
}

const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))

/**
 * The default markup. Each function gets the view model (`model()` or `tileModel()`,
 * plus `labels` and `icons`) and returns the HTML rendered the first time the view
 * shows; from then on the `data-calls-*` hooks keep it current.
 */
export const templates = {
    incoming: (v) => `
        <div class="calls-card calls-incoming" role="alertdialog" data-calls-scope>
            <div class="calls-person">
                <img class="calls-avatar" alt="" data-calls-src="peerAvatar" data-calls-show="hasAvatar">
                <span class="calls-avatar calls-avatar-initials" data-calls-text="initials" data-calls-show="!hasAvatar"></span>
                <div class="calls-who">
                    <div class="calls-name" data-calls-text="peerName"></div>
                    <div class="calls-dim">${escape(v.labels.incoming)} <span data-calls-show="hasOthers">· <span data-calls-text="othersLabel"></span></span></div>
                </div>
            </div>
            <div class="calls-actions">
                <button type="button" class="calls-btn calls-btn-danger" data-calls-action="decline" title="${escape(v.labels.decline)}">${v.icons.phoneX}</button>
                <button type="button" class="calls-btn calls-btn-success calls-pulse" data-calls-action="accept" title="${escape(v.labels.accept)}">${v.icons.phone}</button>
            </div>
        </div>`,

    chip: (v) => `
        <div class="calls-card calls-chip" data-calls-scope>
            <button type="button" class="calls-person calls-chip-open" data-calls-action="focusWindow" title="${escape(v.labels.open_window)}">
                <span class="calls-avatar calls-avatar-initials">${v.icons.window}</span>
                <span class="calls-who">
                    <span class="calls-name" data-calls-text="names"></span>
                    <span class="calls-dim" data-calls-text="status"></span>
                </span>
            </button>
            <button type="button" class="calls-btn calls-btn-danger" data-calls-action="hangUp" title="${escape(v.labels.hang_up)}">${v.icons.phoneX}</button>
        </div>`,

    window: (v) => `
        <div class="calls-card calls-window" data-calls-scope>
            <div class="calls-header">
                <div class="calls-name" data-calls-text="names"></div>
                <div class="calls-dim" data-calls-text="status"></div>
            </div>
            <div class="calls-stage" data-calls-ref="stage" data-calls-attr="data-spotlight:spotlight data-strip:strip">
                <div class="calls-grid" data-calls-ref="grid" data-calls-attr="data-count:count"></div>
                <video autoplay playsinline muted class="calls-local" data-calls-video="localStream" data-calls-class="calls-mirror:mirror calls-hidden:hideLocal"></video>
            </div>
            <div class="calls-controls">
                <button type="button" class="calls-btn" data-calls-action="toggleMute" data-calls-class="calls-btn-off:muted" data-calls-attr="title:muteTitle">${v.icons.microphone}</button>
                <button type="button" class="calls-btn" data-calls-action="toggleCamera" data-calls-class="calls-btn-off:cameraOff" data-calls-attr="title:cameraTitle">
                    <span data-calls-show="!cameraOff">${v.icons.camera}</span><span data-calls-show="cameraOff">${v.icons.cameraOff}</span>
                </button>
                <button type="button" class="calls-btn" data-calls-action="toggleShare" data-calls-show="canShare" data-calls-class="calls-btn-on:sharing" data-calls-attr="title:shareTitle">${v.icons.screen}</button>
                <button type="button" class="calls-btn calls-btn-danger" data-calls-action="hangUp" title="${escape(v.labels.hang_up)}">${v.icons.phoneX}</button>
            </div>
        </div>`,

    tile: (v) => `
        <div class="calls-tile" data-calls-scope data-calls-attr="data-peer-id:id data-peer-status:status data-role:role">
            <video autoplay playsinline class="calls-remote" data-calls-video="stream" data-calls-class="calls-hidden:!showVideo"></video>
            <div class="calls-placeholder" data-calls-show="!showVideo">
                <img class="calls-avatar calls-avatar-lg" alt="" data-calls-src="avatar" data-calls-show="hasAvatar">
                <span class="calls-avatar calls-avatar-lg calls-avatar-initials" data-calls-text="initials" data-calls-show="!hasAvatar"></span>
            </div>
            <div class="calls-tile-name" data-calls-show="showName">
                <span data-calls-text="name"></span>
                <span class="calls-dim" data-calls-show="ringing">${escape(v.labels.calling)}</span>
                <span class="calls-dim" data-calls-show="connecting">${escape(v.labels.connecting)}</span>
            </div>
            <div class="calls-badges">
                <span class="calls-badge" data-calls-show="muted" data-peer="muted">${v.icons.speakerOff} ${escape(v.labels.peer_muted)}</span>
                <span class="calls-badge" data-calls-show="sharing" data-peer="sharing">${v.icons.screen} ${escape(v.labels.peer_sharing)}</span>
                <span class="calls-badge" data-calls-show="cameraOffBadge" data-peer="camera-off">${v.icons.cameraOff} ${escape(v.labels.peer_camera_off)}</span>
            </div>
        </div>`,

    notice: () => '<div class="calls-card calls-notice" role="status" data-calls-scope data-calls-text="notice"></div>',
}

/**
 * Bring a rendered view in line with its model through the `data-calls-*` hooks, without
 * touching nested views (anything inside another `data-calls-scope`):
 *   data-calls-text="key"                   textContent
 *   data-calls-show="key" | "!key"          hidden unless truthy
 *   data-calls-class="name:key name2:!key"  classes toggled
 *   data-calls-attr="name:key name2:key2"   attributes set (null or false removes, true sets it empty)
 *   data-calls-src="key"                    src (removed when empty)
 *   data-calls-video="key"                  a MediaStream as srcObject, playing
 */
export function patch(root, model) {
    const read = (expr) => {
        const negated = expr.startsWith('!')
        const value = model[negated ? expr.slice(1) : expr]

        return negated ? ! value : value
    }
    const each = (attribute, apply) => {
        const elements = [...root.querySelectorAll(`[${attribute}]`)].filter((el) => el.closest('[data-calls-scope]') === root)
        if (root.hasAttribute(attribute)) elements.unshift(root)
        for (const el of elements) apply(el, el.getAttribute(attribute))
    }
    const pairs = (spec) => spec.split(/\s+/).filter(Boolean).map((pair) => pair.split(':'))

    each('data-calls-text', (el, key) => {
        const text = String(read(key) ?? '')
        if (el.textContent !== text) el.textContent = text
    })
    each('data-calls-show', (el, key) => { el.hidden = ! read(key) })
    each('data-calls-class', (el, spec) => { for (const [name, key] of pairs(spec)) el.classList.toggle(name, Boolean(read(key))) })
    each('data-calls-attr', (el, spec) => {
        for (const [name, key] of pairs(spec)) {
            const value = read(key)
            if (value === null || value === undefined || value === false) el.removeAttribute(name)
            else if (el.getAttribute(name) !== String(value === true ? '' : value)) el.setAttribute(name, value === true ? '' : value)
        }
    })
    each('data-calls-src', (el, key) => {
        const value = read(key)
        if (! value) el.removeAttribute('src')
        else if (el.getAttribute('src') !== value) el.setAttribute('src', value)
    })
    each('data-calls-video', (el, key) => attachStream(el, read(key) ?? null))
}

/** A stream on a <video>, once: setting the same stream again would restart playback. */
export function attachStream(video, stream) {
    if (video.srcObject === stream) return
    video.srcObject = stream
    if (stream) {
        try { video.play()?.catch?.(() => {}) } catch {}
    }
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
        const found = window.open('', 'packstub-calls', features)
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
     * @param {string|null} [options.callSelector]  elements that ring someone on click; the user id is in `data-calls-call` (null: none)
     * @param {object} [options.labels]  texts to override
     * @param {object} [options.templates]  views to override: incoming, chip, window, tile, notice
     * @param {object} [options.icons]  SVG strings to override
     * @param {boolean} [options.startPolling]  start polling at once (true)
     * @param {string} [options.kind]  the kind of calls this widget draws (`call`); other packages' calls never reach it
     * @param {'all'|'relay'} [options.iceTransportPolicy]
     */
    constructor(options = {}) {
        super()
        const {
            client = null, signaling = null, routes = null, csrf = null, iceServers = null, video = true, poll, reconnectTimeout, maxParticipants,
            root = document.body, windowUrl = null, inPopOut = false, popOut = windowUrl !== null, openedFor = null,
            windowFeatures = 'popup=yes,width=460,height=620', callSelector = '[data-calls-call]', startPolling = true,
            kind = 'call', iceTransportPolicy = 'all',
        } = options

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
            // A page that leaves calls to the pop-out never takes one over itself.
            resumes: ! this.popOut,
        })

        this.state = 'idle'
        this.call = null
        this.peers = []
        this.muted = false
        this.cameraOff = false
        this.sharing = false
        this.strip = 'top'
        this.notice = null
        this.seconds = 0
        this.views = { incoming: null, chip: null, window: null, notice: null }
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

        this.mount(root)
        this.listen()
        if (startPolling) this.start()
    }

    // ---- lifecycle -----------------------------------------------------------

    mount(root) {
        this.el = document.createElement('div')
        this.el.className = this.inPopOut ? 'calls calls-popup' : 'calls'
        this.slots = {}
        for (const name of ['incoming', 'chip', 'window', 'notice']) {
            const slot = document.createElement('div')
            slot.className = `calls-slot calls-slot-${name}`
            slot.hidden = true
            this.el.appendChild(slot)
            this.slots[name] = slot
        }
        this.el.addEventListener('click', (event) => {
            const button = event.target.closest('[data-calls-action]')
            if (button && this.el.contains(button)) this.act(button.getAttribute('data-calls-action'))
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

            this.syncUrl()
            this.ring.stop()
            if (state === 'ringing') this.ring.play('ring')
            if (state === 'calling') this.ring.play('ringback')

            if (state === 'active' || (state === 'elsewhere' && client.call?.status === 'active')) this.startClock()
            else if (! ['reconnecting', 'connecting'].includes(state)) this.stopClock()

            this.render()
        })
        this.on(client, 'incoming', ({ detail: { call } }) => { this.call = call; this.render() })
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
        this.on(client, 'localstream', () => this.render())
        this.on(client, 'peers', () => this.render())
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
            console.warn('[calls]', error)
            if (media) this.show(this.labels.no_media)
            // The server's own words for a refusal it explains (not allowed, full); nothing raw from a crash.
            else if (error?.reason && error.status >= 400 && error.status < 500) this.show(error.message)
        })

        // Everything the client says, again on the page: `calls:statechange`, `calls:ended`…
        for (const type of ['statechange', 'incoming', 'update', 'localstream', 'remotestream', 'peers', 'peerjoined', 'peerleft', 'peerstate', 'ended', 'error']) {
            this.on(client, type, ({ detail }) => this.emit(type, detail))
        }

        // Any button on the page that names a person, and a `calls:call` event with { user }.
        if (this.callSelector) {
            this.on(document, 'click', (event) => {
                const button = event.target.closest?.(this.callSelector)
                if (button) this.callUser(button.getAttribute('data-calls-call'))
            })
        }
        this.on(window, 'calls:call', (event) => this.callUser(event.detail?.user))
        // A full page load: let go of the call so this or the next page can pick it up again.
        this.on(window, 'pagehide', () => client.leave())
    }

    emit(type, detail) {
        this.el.dispatchEvent(new CustomEvent(`calls:${type}`, { detail, bubbles: true }))
        this.dispatchEvent(new CustomEvent(type, { detail }))
    }

    // ---- actions -------------------------------------------------------------

    act(name) {
        const actions = { accept: 'accept', decline: 'decline', hangUp: 'hangUp', toggleMute: 'toggleMute', toggleCamera: 'toggleCamera', toggleShare: 'toggleShare', focusWindow: 'focusWindow' }
        if (actions[name]) this[actions[name]]()
    }

    /** Ring someone; on a call already (here, or in my pop-out) add them to it. */
    callUser(user) {
        if (! user) return

        if (this.inCall || this.state === 'elsewhere') {
            return this.add(user)
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

    show(text) {
        this.notice = text
        clearTimeout(this.noticeTimer)
        this.noticeTimer = setTimeout(() => { this.notice = null; this.render() }, 4000)
        this.render()
    }

    // ---- the pop-out ---------------------------------------------------------

    /** The pop-out was opened to ring someone: from then on its URL names the call, so a reload continues it instead of ringing again. */
    syncUrl() {
        const call = this.client.call
        if (this.inPopOut && call && this.windowUrl && ! location.search.includes('call=' + call.id)) {
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
            this.popupWindow = window.open(url, 'packstub-calls', this.windowFeatures)
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
        const orphaned = this.popOut && this.state === 'elsewhere' && this.call && ! this.call.held && this.call.status !== 'ended'

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
        const names = this.peers.map((peer) => peer.name)

        return names.length ? names.join(', ') : (this.call?.peer?.name ?? '')
    }

    /** The peer whose screen has the stage: the first one sharing with video coming in, or null. */
    get spotlight() {
        return this.peers.find((peer) => peer.sharing && peer.hasVideo)?.id ?? null
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
        if (this.state === 'active') return this.elapsed
        if (this.state === 'elsewhere') {
            if (this.call?.held) return this.call?.status === 'active' ? this.elapsed : labels.calling
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
            peerAvatar: peer?.avatar ?? null,
            hasAvatar: Boolean(peer?.avatar),
            initials: this.initials(peer?.name),
            others,
            hasOthers: others > 0,
            othersLabel: fill(this.labels.and_more, { count: others }),
            // The call window
            muted: this.muted,
            cameraOff: this.cameraOff,
            sharing: this.sharing,
            canShare: this.state === 'active',
            mirror: ! this.sharing,
            hideLocal: this.cameraOff && ! this.sharing,
            localStream: this.client.localStream,
            count: this.peers.length,
            spotlight,
            strip: spotlight ? (this.peers.length > 1 ? this.strip : 'none') : null,
            muteTitle: this.muted ? this.labels.unmute : this.labels.mute,
            cameraTitle: this.cameraOff ? this.labels.camera_on : this.labels.camera_off,
            shareTitle: this.sharing ? this.labels.stop_sharing : this.labels.share_screen,
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
            hasAvatar: Boolean(peer.avatar),
            ringing: peer.status === 'ringing',
            connecting: peer.status === 'joined' && ! peer.connected,
            showVideo,
            showName: this.peers.length > 1 || peer.status !== 'joined',
            cameraOffBadge: peer.cameraOff && ! peer.sharing,
            role: spotlight ? (peer.id === spotlight ? 'spotlight' : 'strip') : null,
        }
    }

    // ---- rendering -------------------------------------------------------------

    /** Draw what the state calls for: one view per slot, created when it appears and patched after. */
    render() {
        this.peers = this.client.peers.map((peer) => ({ ...peer, hasVideo: (peer.stream?.getVideoTracks().length ?? 0) > 0 }))
        const model = this.model()

        this.toggleView('incoming', this.state === 'ringing', model)
        this.toggleView('chip', this.state === 'elsewhere', model)
        this.toggleView('window', this.inCall, model)
        this.toggleView('notice', Boolean(this.notice), model)

        if (this.views.window) this.renderTiles(model.spotlight)
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
        const grid = this.views.window.querySelector('[data-calls-ref="grid"]')
        if (! grid) return

        const kept = new Set()
        let previous = null

        for (const peer of this.peers) {
            let tile = [...grid.children].find((child) => child.getAttribute('data-calls-peer') === String(peer.id)) ?? null
            const model = this.tileModel(peer, spotlight)

            if (! tile) {
                const holder = document.createElement('div')
                holder.innerHTML = this.templates.tile(model)
                tile = holder.firstElementChild
                tile.setAttribute('data-calls-peer', String(peer.id))
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
        const stage = this.views.window?.querySelector('[data-calls-ref="stage"]')
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
