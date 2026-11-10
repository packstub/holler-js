// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CallWidget, attachStream, patch, safeUrl, templates } from '../src/widget.js'
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
    instance.el.addEventListener('calls:statechange', ({ detail }) => instance.log.push(detail.state))

    return instance
}

const connectAll = (...widgets) => {
    for (const instance of widgets) for (const link of instance.client.topology.links.values()) link.pc.setConnectionState('connected')
}

/** A peer's camera arrives on this side. */
const receiveVideo = (instance, peerId) => instance.client.topology.link(peerId).pc.receiveTrack(new FakeTrack('video'))

const visible = (instance, name) => instance.views[name]
const tiles = (instance) => [...instance.el.querySelectorAll('.calls-tile')]
const tile = (instance, id) => instance.el.querySelector(`.calls-tile[data-peer-id="${id}"]`)

async function connected(options = {}) {
    const ion = widget('ion', options.ion)
    const ana = widget('ana', options.ana)
    await ion.callUser('ana')
    await settle()
    ana.el.querySelector('[data-calls-action="accept"]').click()
    await settle()
    connectAll(ion, ana)
    await settle()

    return { ion, ana }
}

describe('the widget', () => {
    it('mounts at the end of the body with every view out of sight', () => {
        const ion = widget('ion')

        expect(document.body.lastElementChild).toBe(ion.el)
        expect(ion.el.className).toBe('calls')
        expect([...ion.el.querySelectorAll('.calls-slot')].every((slot) => slot.hidden)).toBe(true)
        expect(ion.state).toBe('idle')
    })

    it('shows the incoming toast with the caller, accepts from it and draws the call window with a tile per peer', async () => {
        const ion = widget('ion')
        const ana = widget('ana')
        await ion.callUser('ana')
        await settle()

        expect(ion.state).toBe('calling')
        expect(visible(ion, 'window')).toBeTruthy()
        expect(ion.el.querySelector('.calls-header .calls-name').textContent).toBe('Ana Popescu')
        expect(ion.el.querySelector('.calls-header .calls-dim').textContent).toBe('Calling…')
        expect(tiles(ion).map((el) => el.dataset.peerStatus)).toEqual(['ringing'])

        const toast = visible(ana, 'incoming')
        expect(toast).toBeTruthy()
        expect(toast.getAttribute('role')).toBe('alertdialog')
        expect(toast.querySelector('.calls-name').textContent).toBe('Ion Caliman')
        expect(toast.querySelector('[data-calls-text="initials"]').textContent).toBe('IC')
        expect(toast.querySelector('[data-calls-show="hasOthers"]').hidden).toBe(true)

        toast.querySelector('[data-calls-action="accept"]').click()
        await settle()
        connectAll(ion, ana)
        await settle()

        expect(ana.state).toBe('active')
        expect(visible(ana, 'incoming')).toBeNull()
        expect(tiles(ana).map((el) => el.dataset.peerId)).toEqual(['ion'])
        expect(tile(ion, 'ana').dataset.peerStatus).toBe('joined')
        // A single peer: no name on the tile, the header says who.
        expect(tile(ion, 'ana').querySelector('.calls-tile-name').hidden).toBe(true)
        expect(ion.el.querySelector('.calls-local').srcObject).toBe(ion.client.localStream)
    })

    it('keeps a tile by peer id across renders, shows their video once it arrives, and a badge only on the one who muted', async () => {
        const { ion, ana } = await connected()
        const before = tile(ion, 'ana')
        const video = before.querySelector('video')
        expect(video.classList.contains('calls-hidden')).toBe(true)

        receiveVideo(ion, 'ana')
        await settle()

        expect(tile(ion, 'ana')).toBe(before)
        expect(video.classList.contains('calls-hidden')).toBe(false)
        expect(video.srcObject).toBe(ion.client.peer.stream)
        expect(before.querySelector('.calls-placeholder').hidden).toBe(true)

        ana.toggleMute()
        await settle()
        expect(before.querySelector('[data-peer="muted"]').hidden).toBe(false)
        expect(before.querySelector('[data-peer="sharing"]').hidden).toBe(true)
        expect(ana.el.querySelector('[data-calls-action="toggleMute"]').classList.contains('calls-btn-off')).toBe(true)
        expect(ana.el.querySelector('[data-calls-action="toggleMute"]').title).toBe('Unmute')
    })

    it('rings whoever a data-calls-call element names, and adds them to the call once on one', async () => {
        const ion = widget('ion')
        // The others share this document in the test: only Ion's widget listens to its buttons.
        widget('ana', { callSelector: null })
        widget('mihai', { callSelector: null })
        document.body.insertAdjacentHTML('afterbegin', '<button id="ana" data-calls-call="ana">Call</button><button id="mihai" data-calls-call="mihai">Call</button>')

        document.getElementById('ana').click()
        await settle()
        expect(ion.state).toBe('calling')
        expect(server.log.find(([, action]) => action === 'start')).toEqual(['ion', 'start', 'ana', ion.client.tab])

        document.getElementById('mihai').click()
        await settle()
        expect(server.log.find(([, action]) => action === 'invite')).toEqual(['ion', 'invite', 1, 'mihai'])
        expect(tiles(ion).map((el) => el.dataset.peerId)).toEqual(['ana', 'mihai'])
        expect(visible(ion, 'notice').textContent).toBe('Ringing Mihai Rusu…')
        expect(ion.el.querySelector('.calls-header .calls-name').textContent).toBe('Ana Popescu, Mihai Rusu')
        // Tiles show names once there is more than one.
        expect(tile(ion, 'ana').querySelector('.calls-tile-name').hidden).toBe(false)
    })

    it('removes the tile of someone who left, says so, and clears the window when the call ends', async () => {
        const { ion, ana } = await connected()
        const mihai = widget('mihai')
        await ion.add('mihai')
        await settle()
        mihai.el.querySelector('[data-calls-action="accept"]').click()
        await settle()
        connectAll(ion, ana, mihai)
        await settle()
        expect(tiles(ion)).toHaveLength(2)

        mihai.hangUp()
        await settle()

        expect(tiles(ion).map((el) => el.dataset.peerId)).toEqual(['ana'])
        expect(visible(ion, 'notice').textContent).toBe('Mihai Rusu left the call')
        expect(ion.state).toBe('active')

        ana.el.querySelector('[data-calls-action="hangUp"]').click()
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
        mihai.el.querySelector('[data-calls-action="accept"]').click()
        await settle()
        connectAll(ion, ana, mihai)
        await settle()
        receiveVideo(ion, 'ana')
        receiveVideo(ion, 'mihai')
        const sharing = []
        ion.el.addEventListener('calls:sharing', ({ detail }) => sharing.push(detail))
        const stage = ion.el.querySelector('.calls-stage')
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
        expect(ion.el.querySelector('.calls-stage').getAttribute('data-strip')).toBe('top')
        mihai.hangUp()
        await settle()
        expect(ion.el.querySelector('.calls-stage').getAttribute('data-strip')).toBe('none')
    })

    it('takes your own templates, labels and icons, keeping whichever hooks you use up to date', async () => {
        const ion = widget('ion')
        const ana = widget('ana', {
            labels: { incoming: 'te sună', accept: 'Răspunde' },
            icons: { phone: '<i class="my-phone"></i>' },
            templates: {
                incoming: (v) => `<div class="my-toast" data-calls-scope><b data-calls-text="peerName"></b> ${v.labels.incoming} <button data-calls-action="accept">${v.icons.phone}${v.labels.accept}</button></div>`,
                tile: () => '<div class="my-tile" data-calls-scope data-calls-attr="data-peer-id:id" data-calls-text="name"></div>',
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
        expect(ana.el.querySelector('.my-tile').dataset.callsPeer).toBe('ion')
    })

    it('patches text, visibility, classes, attributes and sources through the hooks, and leaves nested scopes alone', () => {
        document.body.innerHTML = `
            <div id="root" data-calls-scope data-calls-attr="data-count:count data-flag:flag data-none:none">
                <span data-calls-text="name"></span>
                <span id="shown" data-calls-show="on"></span>
                <span id="hidden" data-calls-show="!on"></span>
                <i data-calls-class="is-on:on is-off:!on"></i>
                <img data-calls-src="avatar">
                <div id="nested" data-calls-scope><span data-calls-text="name">nested</span></div>
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

    it('dispatches every client event on the page as calls:<type>, and the toast for errors', async () => {
        const ion = widget('ion')
        const seen = []
        document.addEventListener('calls:ended', ({ detail }) => seen.push(detail.reason))
        document.addEventListener('calls:peers', ({ detail }) => seen.push(detail.peers.length))
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
        expect(ionWindow.el.className).toBe('calls calls-popup')
        await settle()
        expect(ionWindow.state).toBe('calling')
        expect(location.search).toBe('?call=1&callee=')
        // The main page sees its call held elsewhere: the chip, with the name and status.
        expect(ion.state).toBe('elsewhere')
        expect(visible(ion, 'chip').querySelector('.calls-name').textContent).toBe('Ana Popescu')

        // Ana accepts from the toast: her pop-out opens for the call and her page hands off.
        visible(ana, 'incoming').querySelector('[data-calls-action="accept"]').click()
        expect(opened.at(-1)).toMatch(/^\/calls\/window\?call=1&callee=&open=\w+$/)
        expect(ana.state).toBe('elsewhere')
        history.replaceState(null, '', opened.at(-1))
        const anaWindow = widget('ana', { inPopOut: true, windowUrl: '/calls/window?call=__ID__&callee=__USER__' })
        await settle()
        connectAll(ionWindow, anaWindow)
        await settle()
        expect(anaWindow.state).toBe('active')
        expect(ionWindow.state).toBe('active')
        expect(visible(ana, 'chip').querySelector('.calls-dim').textContent).toMatch(/^\d:\d\d$/)

        // Hanging up from the chip ends the call in the window too.
        visible(ana, 'chip').querySelector('[data-calls-action="hangUp"]').click()
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

        expect(Object.keys(localStorage).filter((key) => key.startsWith('packstub-calls:open:'))).toEqual([])
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
        root.setAttribute('data-calls-scope', '')
        root.innerHTML = '<img data-calls-src="avatar">'
        const img = root.querySelector('img')

        for (const bad of ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'data:image/svg+xml,<svg onload=alert(1)>', 'vbscript:x']) {
            patch(root, { avatar: bad })
            expect(img.hasAttribute('src'), bad).toBe(false)
        }

        for (const good of ['https://cdn.example.com/a.png', '/storage/avatars/1.jpg', 'avatars/1.jpg', 'data:image/png;base64,iVBOR', 'blob:https://example.com/1']) {
            patch(root, { avatar: good })
            expect(img.getAttribute('src')).toBe(good)
        }
        expect(safeUrl(null)).toBeNull()
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
        expect(ana.el.querySelector('.calls-live').textContent).toBe('Ion Caliman is calling you')
        for (const button of ana.el.querySelectorAll('button')) expect(button.getAttribute('aria-label')).toBeTruthy()
    })

    it('keeps focus in the widget when Accept goes away, on the first call control rather than hang up', async () => {
        const ion = widget('ion')
        const ana = widget('ana', { callSelector: null })
        await ion.callUser('ana')
        await settle()

        const accept = ana.el.querySelector('[data-calls-action="accept"]')
        accept.focus()
        accept.click()
        await settle()

        expect(document.activeElement.getAttribute('data-calls-action')).toBe('toggleMute')
        expect(ana.views.window.getAttribute('aria-label')).toBe('Ion Caliman')

        ana.el.querySelector('[data-calls-action="toggleMute"]').click()
        expect(document.activeElement.getAttribute('aria-label')).toBe('Unmute')
    })

    it('reads notices out through a live region that is there before the text', async () => {
        const ion = widget('ion')
        const live = ion.el.querySelector('.calls-live')
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
        const share = (instance) => instance.el.querySelector('[data-calls-action="toggleShare"]')
        expect(share(ion).hidden).toBe(false)

        delete navigator.mediaDevices.getDisplayMedia
        ana.render()

        expect(share(ana).hidden).toBe(true)
    })
})
