// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CallWidget, attachStream, escape, patch, safeUrl, templates } from '../src/widget.js'
import { FakeServer, FakeTrack, installBrowserGlobals } from './fakes.js'

let server

beforeEach(() => {
    vi.useFakeTimers()
    installBrowserGlobals()
    // jsdom plays nothing: a <video> accepts the stream and that is all the widget needs.
    HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('ResizeObserver', undefined)
    server = new FakeServer().name('ion', 'Ion Caliman').name('ana', 'Ana Popescu').name('mihai', 'Mihai Rusu')
    document.body.innerHTML = ''
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

const settle = (ms = 150) => vi.advanceTimersByTimeAsync(ms)

function widget(user, options = {}) {
    const instance = new CallWidget({ signaling: server.clientFor(user), poll: { idle: 100, active: 50 }, reconnectTimeout: 1000, ...options })
    instance.log = []
    instance.el.addEventListener('holler:statechange', ({ detail }) => instance.log.push(detail.state))

    return instance
}

const connectAll = (...widgets) => {
    for (const instance of widgets) for (const link of instance.client.topology.links.values()) link.pc.setConnectionState('connected')
}

/** A peer's camera arrives on this side. */
const receiveVideo = (instance, peerId) => instance.client.topology.link(peerId).pc.receiveTrack(new FakeTrack('video'))

const visible = (instance, name) => instance.views[name]
const tiles = (instance) => [...instance.el.querySelectorAll('.holler-tile')]
const tile = (instance, id) => instance.el.querySelector(`.holler-tile[data-peer-id="${id}"]`)

async function connected(options = {}) {
    const ion = widget('ion', options.ion)
    const ana = widget('ana', options.ana)
    await ion.callUser('ana')
    await settle()
    ana.el.querySelector('[data-holler-action="accept"]').click()
    await settle()
    connectAll(ion, ana)
    await settle()

    return { ion, ana }
}

describe('the widget', () => {
    it('mounts at the end of the body with every view out of sight', () => {
        const ion = widget('ion')

        expect(document.body.lastElementChild).toBe(ion.el)
        expect(ion.el.className).toBe('holler')
        expect([...ion.el.querySelectorAll('.holler-slot')].every((slot) => slot.hidden)).toBe(true)
        expect(ion.state).toBe('idle')
    })

    it('shows the incoming toast with the caller, accepts from it and draws the call window with a tile per peer', async () => {
        const ion = widget('ion')
        const ana = widget('ana')
        await ion.callUser('ana')
        await settle()

        expect(ion.state).toBe('calling')
        expect(visible(ion, 'window')).toBeTruthy()
        expect(ion.el.querySelector('.holler-header .holler-name').textContent).toBe('Ana Popescu')
        expect(ion.el.querySelector('.holler-header .holler-dim').textContent).toBe('Calling…')
        expect(tiles(ion).map((el) => el.dataset.peerStatus)).toEqual(['ringing'])

        const toast = visible(ana, 'incoming')
        expect(toast).toBeTruthy()
        expect(toast.getAttribute('role')).toBe('alertdialog')
        expect(toast.querySelector('.holler-name').textContent).toBe('Ion Caliman')
        expect(toast.querySelector('[data-holler-text="initials"]').textContent).toBe('IC')
        expect(toast.querySelector('[data-holler-show="hasOthers"]').hidden).toBe(true)

        toast.querySelector('[data-holler-action="accept"]').click()
        await settle()
        connectAll(ion, ana)
        await settle()

        expect(ana.state).toBe('active')
        expect(visible(ana, 'incoming')).toBeNull()
        expect(tiles(ana).map((el) => el.dataset.peerId)).toEqual(['ion'])
        expect(tile(ion, 'ana').dataset.peerStatus).toBe('joined')
        // A single peer: no name on the tile, the header says who.
        expect(tile(ion, 'ana').querySelector('.holler-tile-name').hidden).toBe(true)
        expect(ion.el.querySelector('.holler-local').srcObject).toBe(ion.client.localStream)
    })

    it('keeps a tile by peer id across renders, shows their video once it arrives, and a badge only on the one who muted', async () => {
        const { ion, ana } = await connected()
        const before = tile(ion, 'ana')
        const video = before.querySelector('video')
        expect(video.classList.contains('holler-hidden')).toBe(true)

        receiveVideo(ion, 'ana')
        await settle()

        expect(tile(ion, 'ana')).toBe(before)
        expect(video.classList.contains('holler-hidden')).toBe(false)
        expect(video.srcObject).toBe(ion.client.peer.stream)
        expect(before.querySelector('.holler-placeholder').hidden).toBe(true)

        ana.toggleMute()
        await settle()
        expect(before.querySelector('[data-peer="muted"]').hidden).toBe(false)
        expect(before.querySelector('[data-peer="sharing"]').hidden).toBe(true)
        expect(ana.el.querySelector('[data-holler-action="toggleMute"]').classList.contains('holler-btn-off')).toBe(true)
        expect(ana.el.querySelector('[data-holler-action="toggleMute"]').title).toBe('Unmute')
    })

    it('rings whoever a data-holler-call element names, and adds them to the call once on one', async () => {
        const ion = widget('ion')
        // The others share this document in the test: only Ion's widget listens to its buttons.
        widget('ana', { callSelector: null })
        widget('mihai', { callSelector: null })
        document.body.insertAdjacentHTML('afterbegin', '<button id="ana" data-holler-call="ana">Call</button><button id="mihai" data-holler-call="mihai">Call</button>')

        document.getElementById('ana').click()
        await settle()
        expect(ion.state).toBe('calling')
        expect(server.log.find(([, action]) => action === 'start')).toEqual(['ion', 'start', 'ana', ion.client.tab])

        document.getElementById('mihai').click()
        await settle()
        expect(server.log.find(([, action]) => action === 'invite')).toEqual(['ion', 'invite', 1, 'mihai'])
        expect(tiles(ion).map((el) => el.dataset.peerId)).toEqual(['ana', 'mihai'])
        expect(visible(ion, 'notice').textContent).toBe('Ringing Mihai Rusu…')
        expect(ion.el.querySelector('.holler-header .holler-name').textContent).toBe('Ana Popescu, Mihai Rusu')
        // Tiles show names once there is more than one.
        expect(tile(ion, 'ana').querySelector('.holler-tile-name').hidden).toBe(false)
    })

    it('removes the tile of someone who left, says so, and clears the window when the call ends', async () => {
        const { ion, ana } = await connected()
        const mihai = widget('mihai')
        await ion.add('mihai')
        await settle()
        mihai.el.querySelector('[data-holler-action="accept"]').click()
        await settle()
        connectAll(ion, ana, mihai)
        await settle()
        expect(tiles(ion)).toHaveLength(2)

        mihai.hangUp()
        await settle()

        expect(tiles(ion).map((el) => el.dataset.peerId)).toEqual(['ana'])
        expect(visible(ion, 'notice').textContent).toBe('Mihai Rusu left the call')
        expect(ion.state).toBe('active')

        ana.el.querySelector('[data-holler-action="hangUp"]').click()
        await settle()

        expect(ion.state).toBe('idle')
        expect(visible(ion, 'window')).toBeNull()
        expect(visible(ion, 'notice').textContent).toBe('Call ended')
        await settle(4100)
        expect(visible(ion, 'notice')).toBeNull()
    })

    it('puts a shared screen in the spotlight: whole, with the other cameras in a strip where the screen gets more room', async () => {
        const { ion, ana } = await connected()
        const mihai = widget('mihai')
        await ion.add('mihai')
        await settle()
        mihai.el.querySelector('[data-holler-action="accept"]').click()
        await settle()
        connectAll(ion, ana, mihai)
        await settle()
        receiveVideo(ion, 'ana')
        receiveVideo(ion, 'mihai')
        const sharing = []
        ion.el.addEventListener('holler:sharing', ({ detail }) => sharing.push(detail))
        const stage = ion.el.querySelector('.holler-stage')
        expect(stage.hasAttribute('data-spotlight')).toBe(false)

        await mihai.toggleShare()
        await settle()

        expect(stage.getAttribute('data-spotlight')).toBe('mihai')
        expect(stage.getAttribute('data-strip')).toBe('top')
        expect(tile(ion, 'mihai').dataset.role).toBe('spotlight')
        expect(tile(ion, 'ana').dataset.role).toBe('strip')
        expect(tile(ion, 'mihai').querySelector('[data-peer="sharing"]').hidden).toBe(false)
        expect(sharing.at(-1)).toMatchObject({ peer: { id: 'mihai' }, sharing: true, spotlight: 'mihai' })

        // A wide stage puts the strip on the right; a tall one on top.
        ion.placeStrip(900, 400)
        expect(stage.getAttribute('data-strip')).toBe('right')
        ion.placeStrip(460, 500)
        expect(stage.getAttribute('data-strip')).toBe('top')

        await mihai.toggleShare()
        await settle()
        expect(stage.hasAttribute('data-spotlight')).toBe(false)
        expect(tile(ion, 'mihai').hasAttribute('data-role')).toBe(false)

        // With one peer only, the screen simply fills the stage.
        await ana.toggleShare()
        await settle()
        expect(ion.el.querySelector('.holler-stage').getAttribute('data-strip')).toBe('top')
        mihai.hangUp()
        await settle()
        expect(ion.el.querySelector('.holler-stage').getAttribute('data-strip')).toBe('none')
    })

    it('takes your own templates, labels and icons, keeping whichever hooks you use up to date', async () => {
        const ion = widget('ion')
        const ana = widget('ana', {
            labels: { incoming: 'te sună', accept: 'Răspunde' },
            icons: { phone: '<i class="my-phone"></i>' },
            templates: {
                incoming: (v) => `<div class="my-toast" data-holler-scope><b data-holler-text="peerName"></b> ${v.labels.incoming} <button data-holler-action="accept">${v.icons.phone}${v.labels.accept}</button></div>`,
                tile: () => '<div class="my-tile" data-holler-scope data-holler-attr="data-peer-id:id" data-holler-text="name"></div>',
            },
        })
        await ion.callUser('ana')
        await settle()

        const toast = visible(ana, 'incoming')
        expect(toast.className).toBe('my-toast')
        expect(toast.textContent).toBe('Ion Caliman te sună Răspunde')
        expect(toast.querySelector('.my-phone')).toBeTruthy()

        toast.querySelector('button').click()
        await settle()
        connectAll(ion, ana)
        await settle()

        expect(ana.state).toBe('active')
        expect(ana.el.querySelector('.my-tile').textContent).toBe('Ion Caliman')
        expect(ana.el.querySelector('.my-tile').dataset.peerId).toBe('ion')
        expect(ana.el.querySelector('.my-tile').dataset.hollerPeer).toBe('ion')
    })

    it('patches text, visibility, classes, attributes and sources through the hooks, and leaves nested scopes alone', () => {
        document.body.innerHTML = `
            <div id="root" data-holler-scope data-holler-attr="data-count:count data-flag:flag data-none:none">
                <span data-holler-text="name"></span>
                <span id="shown" data-holler-show="on"></span>
                <span id="hidden" data-holler-show="!on"></span>
                <i data-holler-class="is-on:on is-off:!on"></i>
                <img data-holler-src="avatar">
                <div id="nested" data-holler-scope><span data-holler-text="name">nested</span></div>
            </div>`
        const root = document.getElementById('root')

        patch(root, { name: 'Ana', on: true, count: 2, flag: true, none: null, avatar: 'https://example.test/ana.png' })

        expect(root.querySelector('span').textContent).toBe('Ana')
        expect(document.getElementById('shown').hidden).toBe(false)
        expect(document.getElementById('hidden').hidden).toBe(true)
        expect(root.querySelector('i').className).toBe('is-on')
        expect(root.querySelector('img').getAttribute('src')).toBe('https://example.test/ana.png')
        expect(root.getAttribute('data-count')).toBe('2')
        expect(root.getAttribute('data-flag')).toBe('')
        expect(root.hasAttribute('data-none')).toBe(false)
        expect(document.querySelector('#nested span').textContent).toBe('nested')

        patch(root, { name: 'Ana', on: false, avatar: null })
        expect(root.querySelector('i').className).toBe('is-off')
        expect(root.querySelector('img').hasAttribute('src')).toBe(false)
    })

    it('dispatches every client event on the page as holler:<type>, and the toast for errors', async () => {
        const ion = widget('ion')
        const seen = []
        document.addEventListener('holler:ended', ({ detail }) => seen.push(detail.reason))
        document.addEventListener('holler:peers', ({ detail }) => seen.push(detail.peers.length))
        widget('ana')
        await ion.callUser('ana')
        await settle()
        expect(seen).toContain(1)

        ion.hangUp()
        await settle()
        expect(seen.at(-1)).toBe('cancelled')

        await expect(ion.callUser('ion')).resolves.toBeUndefined()
        expect(visible(ion, 'notice').textContent).toBe('This person cannot be called.')
    })

    it('opens the pop-out for a call and shows the chip while the window runs it; the pop-out reads its task from the URL', async () => {
        const opened = []
        vi.stubGlobal('open', vi.fn((url) => { opened.push(url); return { focus: vi.fn(), closed: false } }))
        const ion = widget('ion', { windowUrl: '/calls/window?call=__ID__&callee=__USER__' })
        const ana = widget('ana', { windowUrl: '/calls/window?call=__ID__&callee=__USER__' })

        ion.callUser('ana')
        expect(opened).toHaveLength(1)
        expect(opened[0]).toMatch(/^\/calls\/window\?call=&callee=ana&open=\w+$/)
        expect(ion.state).toBe('idle')

        // Ion's pop-out: rings Ana from the URL, with the token the page left for it.
        history.replaceState(null, '', opened[0])
        const ionWindow = widget('ion', { inPopOut: true, windowUrl: '/calls/window?call=__ID__&callee=__USER__' })
        expect(ionWindow.el.className).toBe('holler holler-popup')
        await settle()
        expect(ionWindow.state).toBe('calling')
        expect(location.search).toBe('?call=1&callee=')
        // The main page sees its call held elsewhere: the chip, with the name and status.
        expect(ion.state).toBe('elsewhere')
        expect(visible(ion, 'chip').querySelector('.holler-name').textContent).toBe('Ana Popescu')

        // Ana accepts from the toast: her pop-out opens for the call and her page hands off.
        visible(ana, 'incoming').querySelector('[data-holler-action="accept"]').click()
        expect(opened.at(-1)).toMatch(/^\/calls\/window\?call=1&callee=&open=\w+$/)
        expect(ana.state).toBe('elsewhere')
        history.replaceState(null, '', opened.at(-1))
        const anaWindow = widget('ana', { inPopOut: true, windowUrl: '/calls/window?call=__ID__&callee=__USER__' })
        await settle()
        connectAll(ionWindow, anaWindow)
        await settle()
        expect(anaWindow.state).toBe('active')
        expect(ionWindow.state).toBe('active')
        expect(visible(ana, 'chip').querySelector('.holler-dim').textContent).toMatch(/^\d:\d\d$/)

        // Hanging up from the chip ends the call in the window too.
        visible(ana, 'chip').querySelector('[data-holler-action="hangUp"]').click()
        await settle()
        expect(anaWindow.state).toBe('idle')
        expect(ionWindow.state).toBe('idle')
    })

    it('does nothing by itself for a pop-out link someone sent: no call placed, no call answered', async () => {
        const ion = widget('ion')
        await ion.client.callUser('ana')

        // A link to ring Ion, and one to answer the call ringing Ana, without the page's token (or with a forged one).
        history.replaceState(null, '', '/calls/window?call=&callee=ion')
        const forged = widget('ana', { inPopOut: true, windowUrl: '/calls/window?call=__ID__&callee=__USER__' })
        history.replaceState(null, '', `/calls/window?call=${ion.client.call.id}&callee=&open=guess`)
        const answering = widget('ana', { inPopOut: true, windowUrl: '/calls/window?call=__ID__&callee=__USER__' })
        await settle()

        expect(server.log.filter(([user, action]) => user === 'ana' && ['start', 'answer'].includes(action))).toHaveLength(0)
        expect(forged.state).not.toBe('calling')
        // The call ringing her shows, with Accept, and waits for a click.
        expect(answering.state).toBe('ringing')
        expect(visible(answering, 'incoming')).not.toBeNull()
    })

    it('leaves no token behind when the browser blocks the pop-out', async () => {
        vi.stubGlobal('open', vi.fn(() => null))
        const ion = widget('ion', { windowUrl: '/calls/window?call=__ID__&callee=__USER__' })

        ion.callUser('ana')

        expect(Object.keys(localStorage).filter((key) => key.startsWith('holler:open:'))).toEqual([])
    })

    it('destroys cleanly: the element goes, polling stops', async () => {
        const ion = widget('ion')
        await settle()
        const polls = server.log.length
        ion.destroy()
        await settle(500)

        expect(document.querySelector('.calls')).toBeNull()
        expect(server.log.length).toBe(polls)
    })

    it('ships the default templates for anyone building on them', () => {
        expect(Object.keys(templates)).toEqual(['incoming', 'chip', 'window', 'tile', 'notice'])
    })
})

describe('autoplay', () => {
    it('plays muted when the browser wants a click first, and turns the sound on with the first click', async () => {
        const refused = Object.assign(new Error('play() needs a user gesture'), { name: 'NotAllowedError' })
        const play = vi.fn(function () { return this.muted || play.allowed ? Promise.resolve() : Promise.reject(refused) })
        HTMLMediaElement.prototype.play = play
        const video = document.createElement('video')
        document.body.appendChild(video)

        attachStream(video, { id: 'remote' })
        await settle(0)
        expect(video.muted).toBe(true)
        expect(play).toHaveBeenCalledTimes(2)

        play.allowed = true
        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
        await settle(0)
        expect(video.muted).toBe(false)
        expect(play).toHaveBeenCalledTimes(3)

        // Only once: a later click plays nothing again.
        document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
        expect(play).toHaveBeenCalledTimes(3)
    })
})

describe('avatars', () => {
    it('only takes image URLs from the server: never javascript: or another scheme', () => {
        const root = document.createElement('div')
        root.setAttribute('data-holler-scope', '')
        root.innerHTML = '<img data-holler-src="avatar">'
        const img = root.querySelector('img')

        for (const bad of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x']) {
            patch(root, { avatar: bad })
            expect(img.hasAttribute('src'), bad).toBe(false)
        }

        for (const good of ['https://cdn.example.com/a.png', '/storage/avatars/1.jpg', 'avatars/1.jpg', 'data:image/png;base64,iVBOR', 'blob:https://example.com/1']) {
            patch(root, { avatar: good })
            expect(img.getAttribute('src')).toBe(good)
        }
        expect(safeUrl(null)).toBeNull()

        // An SVG avatar shows in an <img>, where no script runs; not in another element.
        patch(root, { avatar: 'data:image/svg+xml,<svg/>' })
        expect(img.getAttribute('src')).toBe('data:image/svg+xml,<svg/>')
        expect(safeUrl('data:image/svg+xml,<svg/>')).toBeNull()
    })
})

describe('accessibility', () => {
    it('names the incoming call and every icon button, and reads the caller out', async () => {
        const ion = widget('ion')
        const ana = widget('ana', { callSelector: null })
        await ion.callUser('ana')
        await settle()

        const toast = ana.views.incoming
        expect(toast.getAttribute('role')).toBe('alertdialog')
        expect(toast.getAttribute('aria-label')).toBe('Ion Caliman is calling you')
        expect(ana.el.querySelector('.holler-live').textContent).toBe('Ion Caliman is calling you')
        for (const button of ana.el.querySelectorAll('button')) expect(button.getAttribute('aria-label')).toBeTruthy()
    })

    it('keeps focus in the widget when Accept goes away, on the first call control rather than hang up', async () => {
        const ion = widget('ion')
        const ana = widget('ana', { callSelector: null })
        await ion.callUser('ana')
        await settle()

        const accept = ana.el.querySelector('[data-holler-action="accept"]')
        accept.focus()
        accept.click()
        await settle()

        expect(document.activeElement.getAttribute('data-holler-action')).toBe('toggleMute')
        expect(ana.views.window.getAttribute('aria-label')).toBe('Ion Caliman')

        ana.el.querySelector('[data-holler-action="toggleMute"]').click()
        expect(document.activeElement.getAttribute('aria-label')).toBe('Unmute')
    })

    it('reads notices out through a live region that is there before the text', async () => {
        const ion = widget('ion')
        const live = ion.el.querySelector('.holler-live')
        expect(live.getAttribute('aria-live')).toBe('polite')

        ion.show('Call ended')
        await settle(100)

        expect(live.textContent).toBe('Call ended')
        expect(ion.views.notice.hasAttribute('role')).toBe(false)
    })
})

describe('screen share', () => {
    it('offers no share button where the browser cannot share a screen (phones)', async () => {
        const { ion, ana } = await connected()
        const share = (instance) => instance.el.querySelector('[data-holler-action="toggleShare"]')
        expect(share(ion).hidden).toBe(false)

        delete navigator.mediaDevices.getDisplayMedia
        ana.render()

        expect(share(ana).hidden).toBe(true)
    })
})

describe('the pop-out URL', () => {
    it('names the call this window runs, also when the old URL named a call whose id starts the same', async () => {
        // A pop-out whose URL still names call 12 (long over) rings Ana: the new call is call 1.
        history.replaceState(null, '', '/calls/window?call=12&callee=ana')
        const popOut = widget('ion', { inPopOut: true, windowUrl: '/calls/window?call=__ID__&callee=__USER__', openedFor: { callee: 'ana', trusted: true } })
        await settle()

        expect(popOut.client.call.id).toBe(1)
        expect(location.search).toBe('?call=1&callee=')
    })
})

describe('escape', () => {
    it('makes a name safe to put into the HTML of a template of your own', () => {
        expect(escape(`<img src=x onerror="alert('1')">&`)).toBe('&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;')
        expect(escape(null)).toBe('')
    })
})

describe('settings, a call in the background and the connection', () => {
    const select = (instance, kind) => instance.el.querySelector(`[data-holler-device="${kind}"]`)
    const choose = (instance, kind, value) => {
        const el = select(instance, kind)
        el.value = value
        el.dispatchEvent(new Event('change', { bubbles: true }))
    }

    beforeEach(() => {
        localStorage.clear()
        delete HTMLMediaElement.prototype.setSinkId
        document.title = 'Orders'
    })

    afterEach(() => vi.restoreAllMocks())

    it('opens the settings with the devices to choose from, the speaker only where the browser can pick one', async () => {
        const { ion } = await connected()
        const button = ion.el.querySelector('[data-holler-action="toggleSettings"]')
        const panel = ion.el.querySelector('.holler-settings')

        expect(panel.hidden).toBe(true)
        expect(button.getAttribute('aria-expanded')).toBe('false')

        button.click()
        await settle()

        expect(panel.hidden).toBe(false)
        expect(button.getAttribute('aria-expanded')).toBe('true')
        expect([...select(ion, 'microphone').options].map((option) => [option.value, option.text])).toEqual([['', 'System default'], ['mic-1', 'Built-in microphone'], ['mic-2', 'Headset']])
        expect(select(ion, 'camera').options).toHaveLength(3)
        expect(select(ion, 'speaker').closest('label').hidden).toBe(true)

        button.click()
        expect(panel.hidden).toBe(true)
    })

    it('switches the microphone from the menu and remembers it for the next page', async () => {
        const { ion } = await connected()
        ion.el.querySelector('[data-holler-action="toggleSettings"]').click()
        await settle()

        choose(ion, 'microphone', 'mic-2')
        await settle()

        expect(navigator.mediaDevices.getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: 'mic-2' } }, video: false })
        expect(JSON.parse(localStorage.getItem('holler:devices'))).toEqual({ microphone: 'mic-2', camera: null, speaker: null })
        expect(select(ion, 'microphone').value).toBe('mic-2')

        ion.destroy()
        const again = widget('ion')
        expect(again.client.selected.microphone).toBe('mic-2')
        expect(widget('ion', { storageKey: null }).client.selected.microphone).toBeNull()
    })

    it('says so when a device cannot be opened, and shows the one still in use', async () => {
        const { ion } = await connected()
        ion.el.querySelector('[data-holler-action="toggleSettings"]').click()
        await settle()
        navigator.mediaDevices.getUserMedia.mockImplementationOnce(async () => { throw Object.assign(new Error('busy'), { name: 'NotReadableError' }) })

        choose(ion, 'camera', 'cam-2')
        await settle()

        expect(ion.el.querySelector('.holler-notice').textContent).toBe('Could not switch to that device.')
        expect(select(ion, 'camera').value).toBe('')
    })

    it('sends the sound to the chosen speaker where the browser can', async () => {
        HTMLMediaElement.prototype.setSinkId = vi.fn(() => Promise.resolve())
        const { ion } = await connected()
        ion.el.querySelector('[data-holler-action="toggleSettings"]').click()
        await settle()

        expect(select(ion, 'speaker').closest('label').hidden).toBe(false)
        expect(HTMLMediaElement.prototype.setSinkId).not.toHaveBeenCalled()

        choose(ion, 'speaker', 'out-1')
        await settle()

        expect(HTMLMediaElement.prototype.setSinkId).toHaveBeenCalledWith('out-1')
        const calls = HTMLMediaElement.prototype.setSinkId.mock.calls.length
        ion.render()
        expect(HTMLMediaElement.prototype.setSinkId).toHaveBeenCalledTimes(calls)
    })

    it('has no settings button with devices off and nothing to ask', async () => {
        const { ion } = await connected({ ion: { devices: false } })

        expect(ion.el.querySelector('[data-holler-action="toggleSettings"]').hidden).toBe(true)
    })

    it('flashes the title of a background tab while a call rings, and puts it back', async () => {
        document.title = 'Orders'
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
        const ion = widget('ion')
        const ana = widget('ana')
        await ion.callUser('ana')
        await settle()

        expect(document.title).toBe('Ion Caliman is calling you')
        await settle(1000)
        expect(document.title).toBe('Orders')
        await settle(1000)
        expect(document.title).toBe('Ion Caliman is calling you')

        await ion.hangUp()
        await settle()
        expect(ana.state).toBe('idle')
        expect(document.title).toBe('Orders')
    })

    it('leaves the title alone in the tab the person is looking at, or with notifications off', async () => {
        document.title = 'Orders'
        vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        const ion = widget('ion')
        widget('ana')
        await ion.callUser('ana')
        await settle()
        expect(document.title).toBe('Orders')
        await ion.hangUp()
        await settle()

        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
        widget('mihai', { notifications: false })
        await ion.callUser('mihai')
        await settle()
        expect(document.title).toBe('Orders')
    })

    it('shows a system notification once allowed, one per call, closed when the call stops ringing', async () => {
        const shown = []
        class FakeNotification {
            static permission = 'default'
            static requestPermission = vi.fn(async () => { FakeNotification.permission = 'granted'; return 'granted' })
            constructor(title, options) { Object.assign(this, { title, options, closed: false }); shown.push(this) }
            close() { this.closed = true }
        }
        vi.stubGlobal('Notification', FakeNotification)
        vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)

        const ion = widget('ion')
        const ana = widget('ana')
        expect(ana.canNotify).toBe(true)
        expect(await ana.enableNotifications()).toBe('granted')
        expect(ana.canNotify).toBe(false)

        await ion.callUser('ana')
        await settle()

        expect(shown).toHaveLength(1)
        expect(shown[0].title).toBe('Ion Caliman is calling you')
        expect(shown[0].options.tag).toBe(`holler-call-${ana.call.id}`)
        expect(shown[0].options.requireInteraction).toBe(true)

        shown[0].onclick()
        expect(shown[0].closed).toBe(true)
        expect(document.title).not.toBe('Ion Caliman is calling you')
    })

    it('offers the notifications link in the settings while the person can still be asked', async () => {
        class FakeNotification {
            static permission = 'default'
            static requestPermission = vi.fn(async () => { FakeNotification.permission = 'denied'; return 'denied' })
        }
        vi.stubGlobal('Notification', FakeNotification)
        const { ion } = await connected()
        ion.el.querySelector('[data-holler-action="toggleSettings"]').click()
        await settle()
        const link = ion.el.querySelector('[data-holler-action="enableNotifications"]')

        expect(link.hidden).toBe(false)
        link.click()
        await settle()
        expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
        expect(link.hidden).toBe(true)
    })

    it('marks a tile whose connection is weak', async () => {
        const { ion } = await connected({ ion: { client: undefined } })
        const badge = () => tile(ion, 'ana').querySelector('[data-peer="quality"]')
        expect(badge().hidden).toBe(true)

        ion.client.topology.link('ana').pc.report = [
            { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
            { id: 'P', type: 'candidate-pair', currentRoundTripTime: 0.9 },
        ]
        const seen = []
        ion.el.addEventListener('holler:quality', ({ detail }) => seen.push(detail.quality))
        await ion.client.measure()

        expect(badge().hidden).toBe(false)
        expect(tile(ion, 'ana').dataset.quality).toBe('poor')
        expect(seen).toEqual(['poor'])
    })
})
