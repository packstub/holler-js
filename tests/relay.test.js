import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CallClient, HttpSignaling, RelaySignaling } from '../src/index.js'
import { FakeServer, installBrowserGlobals, joinChannels } from './fakes.js'

/**
 * Relayed signaling: the caller is the hub and keeps polling, everyone connected to it
 * gets signaling over a data channel. Ion is the hub throughout.
 */

const EVENTS = ['statechange', 'peerjoined', 'peerleft', 'peerstate', 'ended', 'error']
const CHANNEL = 'holler:relay'

let server

beforeEach(() => {
    vi.useFakeTimers()
    installBrowserGlobals()
    server = new FakeServer({ relay: true }).name('ion', 'Ion').name('ana', 'Ana').name('mihai', 'Mihai').name('dana', 'Dana')
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

/** A client whose window relays, or one that does not (`relay: false`): what ships today. */
function client(user, { relay = true, relayOptions = {}, ...options } = {}) {
    const upstream = server.clientFor(user)
    const signaling = relay ? new RelaySignaling(upstream, relayOptions) : upstream
    const instance = new CallClient({ signaling, poll: { idle: 100, active: 50 }, reconnectTimeout: 1000, statsInterval: 0, ...options })
    instance.user = user
    instance.relay = relay ? signaling : null
    instance.log = []
    for (const type of EVENTS) instance.addEventListener(type, (event) => instance.log.push({ type, ...event.detail }))
    instance.events = (type) => instance.log.filter((event) => event.type === type)

    return instance
}

const settle = (ms = 150) => vi.advanceTimersByTimeAsync(ms)

/** The network between two clients comes up: the connection, and the data channels on it. */
function up(a, b) {
    const ab = a.topology.link(b.user)
    const ba = b.topology.link(a.user)
    ab.pc.setConnectionState('connected')
    ba.pc.setConnectionState('connected')
    joinChannels(ab, ba)
}

const requests = (user, what) => server.log.filter(([who, action]) => who === user && (! what || action === what))
const sends = (from, to) => server.log.filter(([who, action, , , target]) => who === from && action === 'send' && (to === undefined || target === to))
const mark = () => server.log.length
const since = (from, user, what) => server.log.slice(from).filter(([who, action]) => who === user && (! what || action === what))

/** Ion rings Ana, she answers, the two connect: Ana rests on the hub. */
async function pair(options = {}) {
    const ion = client('ion', options.ion)
    const ana = client('ana', options.ana)
    ion.start()
    ana.start()

    await ion.callUser('ana')
    await settle()
    await ana.accept()
    await settle()
    up(ion, ana)
    await settle()

    return { ion, ana, callId: ion.call.id }
}

/** One more person joins the call: rung by Ion, answers, and the network comes up to everyone already in it. */
async function add(ion, others, user, options = {}) {
    const joiner = client(user, options)
    joiner.start()
    await ion.invite(user)
    await settle()
    await joiner.accept()
    await settle()
    up(ion, joiner)
    await settle()
    for (const other of others) {
        up(other, joiner)
    }
    await settle()

    return joiner
}

describe('relayed signaling', () => {
    it('lets the peer connected to the hub stop polling, while the hub keeps their side alive', async () => {
        const { ion, ana, callId } = await pair()

        expect(ion.relay.mode).toBe('hub')
        expect(ana.relay.mode).toBe('quiet')
        expect([ion.state, ana.state]).toEqual(['active', 'active'])

        const from = mark()
        // Longer than a quiet side keeps its claim (5 s on this server), in steps a hub poll falls into.
        for (let i = 0; i < 6; i++) {
            server.tick(2)
            await settle(200)
        }

        expect(since(from, 'ana')).toEqual([])
        expect(since(from, 'ion', 'poll').length).toBeGreaterThan(10)
        expect(ana.relay.stats.spared).toBeGreaterThan(10)
        // The hub answered for her: her side is still hers, and she looks alive to Ion.
        expect(server.participant(callId, 'ana')).toMatchObject({ status: 'joined', tab: ana.tab, seen_at: server.now })
        expect(ion.peers[0]).toMatchObject({ id: 'ana', alive: true, connected: true })
        expect(ana.peers[0]).toMatchObject({ id: 'ion', alive: true, connected: true })
        expect([ion.state, ana.state]).toEqual(['active', 'active'])
        expect(ana.events('ended')).toEqual([])
    })

    it('connects a newcomer to the others through the hub: offer, answer and candidates never touch the server', async () => {
        const { ion, ana } = await pair()
        const mihai = client('mihai')
        mihai.start()

        await ion.invite('mihai')
        await settle()
        // Ana heard of Mihai from the hub and made her offer; it waits for him to reach the hub.
        expect(ana.peers.map((peer) => peer.id)).toEqual(['ion', 'mihai'])
        expect(ana.relay.held.get('mihai').signals.map((signal) => signal.type)).toEqual(['offer'])

        await mihai.accept()
        await settle()
        expect(mihai.relay.mode).toBe('polling')
        up(ion, mihai)
        await settle()

        // Through Ion: Ana's offer and Mihai's answer.
        expect(ana.topology.link('mihai').settled).toBe(true)
        expect(mihai.topology.link('ana').settled).toBe(true)
        expect(mihai.topology.link('ana').pc.remoteDescription.type).toBe('offer')
        ana.topology.link('mihai').pc.gatherCandidate({ candidate: 'candidate:ana' })
        mihai.topology.link('ana').pc.gatherCandidate({ candidate: 'candidate:mihai' })
        await settle()
        expect(mihai.topology.link('ana').pc.candidates).toEqual([expect.objectContaining({ candidate: 'candidate:ana' })])
        expect(ana.topology.link('mihai').pc.candidates).toEqual([expect.objectContaining({ candidate: 'candidate:mihai' })])

        expect(sends('ana', 'mihai')).toEqual([])
        expect(sends('mihai', 'ana')).toEqual([])
        expect(ion.relay.stats.relayed).toBeGreaterThanOrEqual(4)
        expect(ana.relay.stats.viaHub).toBeGreaterThanOrEqual(2)

        up(ana, mihai)
        await settle()
        // Connected to the hub, Mihai rests too: only Ion asks the server from here on.
        expect([ion.relay.mode, ana.relay.mode, mihai.relay.mode]).toEqual(['hub', 'quiet', 'quiet'])
        expect([ion.state, ana.state, mihai.state]).toEqual(['active', 'active', 'active'])
        const from = mark()
        await settle(1000)
        expect(since(from, 'ana')).toEqual([])
        expect(since(from, 'mihai')).toEqual([])
        expect(since(from, 'ion', 'poll').length).toBeGreaterThan(10)
    })

    it('sends what two connected peers tell each other straight over their channel', async () => {
        const { ion, ana } = await pair()
        const mihai = await add(ion, [ana], 'mihai')
        const from = mark()

        ana.setMuted(true)
        await settle()

        expect(ion.peers.find((peer) => peer.id === 'ana').muted).toBe(true)
        expect(mihai.peers.find((peer) => peer.id === 'ana').muted).toBe(true)
        expect(since(from, 'ana')).toEqual([])
        expect(ana.relay.stats.direct).toBeGreaterThanOrEqual(2)

        // The hub too: its signals to the people connected to it need no request.
        ion.setCameraOff(true)
        await settle()
        expect(ana.peers.find((peer) => peer.id === 'ion').cameraOff).toBe(true)
        expect(since(from, 'ion', 'send')).toEqual([])
    })

    it('tells the quiet ones who joined and who left', async () => {
        const { ion, ana } = await pair()
        const mihai = await add(ion, [ana], 'mihai')
        expect(ana.events('peerjoined').map((event) => event.peer.id)).toEqual(['ion', 'mihai'])

        const from = mark()
        await mihai.hangUp()
        await settle()

        expect(ana.events('peerleft').map((event) => [event.peer.id, event.reason])).toEqual([['mihai', 'left']])
        expect(ana.peers.map((peer) => peer.id)).toEqual(['ion'])
        expect(since(from, 'ana')).toEqual([])
        expect(ana.state).toBe('active')
    })

    it('ends the call for the quiet ones when it ends on the server', async () => {
        const { ion, ana, callId } = await pair()

        server.end(callId, 'hung_up')
        await settle(300)

        expect(ion.events('ended').map((event) => event.reason)).toEqual(['hung_up'])
        expect(ana.events('ended').map((event) => event.reason)).toEqual(['hung_up'])
        expect([ion.state, ana.state]).toEqual(['idle', 'idle'])
        expect(ana.relay.mode).toBe('polling')
    })

    it('connects four people, three of them quiet', async () => {
        const { ion, ana } = await pair()
        const mihai = await add(ion, [ana], 'mihai')
        const dana = await add(ion, [ana, mihai], 'dana')
        const everyone = [ion, ana, mihai, dana]

        expect(everyone.map((instance) => instance.state)).toEqual(['active', 'active', 'active', 'active'])
        expect(everyone.map((instance) => instance.relay.mode)).toEqual(['hub', 'quiet', 'quiet', 'quiet'])
        for (const instance of everyone) {
            expect(instance.peers).toHaveLength(3)
            expect(instance.peers.every((peer) => peer.connected && peer.alive)).toBe(true)
            expect([...instance.topology.links.values()].every((link) => link.settled)).toBe(true)
        }
        // Nothing between two guests went over the server.
        for (const [a, b] of [['ana', 'mihai'], ['ana', 'dana'], ['mihai', 'dana']]) {
            expect(sends(a, b)).toEqual([])
            expect(sends(b, a)).toEqual([])
        }

        const from = mark()
        for (let i = 0; i < 5; i++) {
            server.tick(2)
            await settle(200)
        }
        expect(server.log.slice(from).filter(([who]) => who !== 'ion')).toEqual([])
        expect(everyone.map((instance) => instance.state)).toEqual(['active', 'active', 'active', 'active'])
        for (const user of ['ana', 'mihai', 'dana']) expect(server.participant(ion.call.id, user).status).toBe('joined')
    })
})

describe('falling back to the server', () => {
    it('polls again the moment the channel to the hub closes, and rests again when it is back', async () => {
        const { ion, ana } = await pair()
        const from = mark()

        ana.topology.link('ion').channels.get(CHANNEL).close()
        await settle(60)

        expect(ana.relay.mode).toBe('polling')
        expect(since(from, 'ana', 'poll').length).toBeGreaterThanOrEqual(1)
        expect([ion.state, ana.state]).toEqual(['active', 'active'])

        // A signal now goes over the server, and arrives.
        ana.setMuted(true)
        await settle()
        expect(since(from, 'ana', 'send')).toHaveLength(1)
        expect(ion.peers[0].muted).toBe(true)

        // A new connection (Ana's network changed and came back): the channel with it.
        ana.topology.connect(ana.roster.get('ion'), { polite: false, reset: true })
        await settle()
        up(ion, ana)
        await settle()
        expect(ana.relay.mode).toBe('quiet')
        const later = mark()
        await settle(500)
        expect(since(later, 'ana')).toEqual([])
    })

    it('polls again when the hub goes silent, although its channel still looks open', async () => {
        const { ion, ana } = await pair({ ana: { relayOptions: { hubTimeout: 400 } } })
        expect(ana.relay.mode).toBe('quiet')

        // The hub's page froze: no polls, no word over the channel.
        ion.stop()
        const from = mark()
        await settle(300)
        expect(since(from, 'ana')).toEqual([])
        await settle(300)

        expect(ana.relay.mode).toBe('polling')
        expect(since(from, 'ana', 'poll').length).toBeGreaterThanOrEqual(1)

        // It thaws: the next word from it lets Ana rest again.
        ion.start()
        await settle()
        expect(ana.relay.mode).toBe('quiet')
    })

    it('polls again when the connection to the hub drops before the channel notices', async () => {
        const { ana } = await pair()
        const from = mark()

        ana.topology.link('ion').pc.setConnectionState('disconnected')
        await settle(60)

        expect(ana.relay.mode).toBe('polling')
        expect(since(from, 'ana', 'poll').length).toBeGreaterThanOrEqual(1)
    })

    it('survives the hub reloading: the others poll at once, reconnect to its new page and rest again', async () => {
        const { ion, ana, callId } = await pair()
        const mihai = await add(ion, [ana], 'mihai')
        const from = mark()

        // The page goes away: the leave beacon, every connection closed.
        ion.destroy()
        await settle(60)
        expect([ana.relay.mode, mihai.relay.mode]).toEqual(['polling', 'polling'])
        expect(since(from, 'ana', 'poll').length).toBeGreaterThanOrEqual(1)
        expect(since(from, 'mihai', 'poll').length).toBeGreaterThanOrEqual(1)
        // The two guests still have each other.
        expect([ana.state, mihai.state]).toEqual(['active', 'active'])

        const again = client('ion')
        again.start()
        await settle(300)

        expect(again.call.id).toBe(callId)
        // Its `reset` and new offers went over the server, to people who were polling for them.
        expect(ana.topology.link('ion').settled).toBe(true)
        expect(mihai.topology.link('ion').settled).toBe(true)
        up(again, ana)
        up(again, mihai)
        await settle()

        expect([again.relay.mode, ana.relay.mode, mihai.relay.mode]).toEqual(['hub', 'quiet', 'quiet'])
        expect([again.state, ana.state, mihai.state]).toEqual(['active', 'active', 'active'])
        expect(ana.events('ended')).toEqual([])
        const later = mark()
        await settle(500)
        expect(server.log.slice(later).filter(([who]) => who !== 'ion')).toEqual([])
    })

    it('reconnects a quiet peer that reloads: its new page polls until it is back on the hub, its offer to the others goes through the hub', async () => {
        const { ion, ana } = await pair()
        const mihai = await add(ion, [ana], 'mihai')

        ana.destroy()
        await settle(60)
        const from = mark()
        const again = client('ana')
        again.start()
        await settle(300)

        // Back on the hub over the server; the `reset` and the offer for Mihai wait for the hub.
        expect(again.topology.link('ion').settled).toBe(true)
        expect(since(from, 'ana', 'poll').length).toBeGreaterThan(1)
        expect(again.relay.held.get('mihai').signals.map((signal) => signal.type)).toEqual(['reset', 'offer'])
        up(ion, again)
        await settle()

        expect(again.topology.link('mihai').settled).toBe(true)
        expect(mihai.topology.link('ana').settled).toBe(true)
        expect(sends('ana', 'mihai')).toEqual([])
        expect(since(from, 'mihai')).toEqual([])
        up(again, mihai)
        await settle()
        expect([ion.state, again.state, mihai.state]).toEqual(['active', 'active', 'active'])
        expect([again.relay.mode, mihai.relay.mode]).toEqual(['quiet', 'quiet'])
    })

    it('goes on without the hub when it leaves: everyone left polls, and still signals over their channels', async () => {
        const { ion, ana } = await pair()
        const mihai = await add(ion, [ana], 'mihai')

        await ion.hangUp()
        await settle(300)

        expect([ana.relay.mode, mihai.relay.mode]).toEqual(['polling', 'polling'])
        expect([ana.state, mihai.state]).toEqual(['active', 'active'])
        expect(ana.peers.map((peer) => peer.id)).toEqual(['mihai'])

        const from = mark()
        await settle(500)
        expect(since(from, 'ana', 'poll').length).toBeGreaterThan(5)
        expect(since(from, 'mihai', 'poll').length).toBeGreaterThan(5)

        // What the two tell each other needs no server: they have a channel.
        mihai.setMuted(true)
        await settle()
        expect(ana.peers[0].muted).toBe(true)
        expect(since(from, 'mihai', 'send')).toEqual([])
    })

    it('polls like everyone else while there is no hub: a caller whose window does not relay', async () => {
        const ion = client('ion', { relay: false })
        const ana = client('ana')
        const mihai = client('mihai')
        for (const instance of [ion, ana, mihai]) instance.start()

        await ion.callUser(['ana', 'mihai'])
        await settle()
        await ana.accept()
        await mihai.accept()
        await settle()
        up(ion, ana)
        up(ion, mihai)
        up(ana, mihai)
        await settle()

        expect([ion.state, ana.state, mihai.state]).toEqual(['active', 'active', 'active'])
        expect([ana.relay.mode, mihai.relay.mode]).toEqual(['polling', 'polling'])
        // The first offers went over the server, as they do today.
        expect(sends('ana', 'mihai').length).toBeGreaterThanOrEqual(1)

        const from = mark()
        await settle(500)
        for (const user of ['ion', 'ana', 'mihai']) expect(since(from, user, 'poll').length).toBeGreaterThan(5)
    })

    it('sends the signals that waited over the server when their peer never reaches the hub', async () => {
        const { ion, ana } = await pair({ ana: { relayOptions: { patience: 300 } } })
        const mihai = client('mihai')
        mihai.start()
        await ion.invite('mihai')
        await settle()
        await mihai.accept()
        await settle(100)

        // Mihai relays, so Ana's offer waits for him; his connection to the hub never comes up.
        expect(ana.relay.held.has('mihai')).toBe(true)
        expect(sends('ana', 'mihai')).toEqual([])
        await settle(400)

        expect(ana.relay.held.has('mihai')).toBe(false)
        expect(sends('ana', 'mihai').map(([, , , type]) => type)).toEqual(['offer'])
        // He polls, answers over the server too (Ana is not within his reach), and the hub tells her to fetch it.
        await settle(300)
        expect(mihai.topology.link('ana').settled).toBe(true)
        expect(ana.topology.link('mihai').settled).toBe(true)
        expect(ana.events('error')).toEqual([])
    })
})

describe('a call with windows that relay and windows that do not', () => {
    it('connects a quiet peer and one that only polls: the hub says when something waits on the server', async () => {
        const { ion, ana } = await pair()
        const mihai = client('mihai', { relay: false })
        mihai.start()
        await ion.invite('mihai')
        await settle()
        await mihai.accept()
        await settle(400)

        // Mihai's window said it does not relay: Ana's offer went over the server, and so did his answer.
        expect(sends('ana', 'mihai').map(([, , , type]) => type)).toEqual(['offer'])
        expect(sends('mihai', 'ana').map(([, , , type]) => type)).toContain('answer')
        expect(ana.topology.link('mihai').settled).toBe(true)
        expect(mihai.topology.link('ana').settled).toBe(true)

        up(ion, mihai)
        up(ana, mihai)
        await settle(300)
        expect([ion.state, ana.state, mihai.state]).toEqual(['active', 'active', 'active'])
        // Ana asked the server only when told to; she rests again, Mihai polls as he always did.
        expect(ana.relay.mode).toBe('quiet')
        const from = mark()
        await settle(500)
        expect(since(from, 'ana')).toEqual([])
        expect(since(from, 'mihai', 'poll').length).toBeGreaterThan(5)

        // Later signals cross the same way.
        mihai.setMuted(true)
        await settle(300)
        expect(ana.peers.find((peer) => peer.id === 'mihai').muted).toBe(true)
        ana.setCameraOff(true)
        await settle(300)
        expect(mihai.peers.find((peer) => peer.id === 'ana').cameraOff).toBe(true)
        expect(ion.peers.find((peer) => peer.id === 'ana').cameraOff).toBe(true)
    })

    it('keeps polling on a backend that names no hub', async () => {
        server = new FakeServer().name('ion', 'Ion').name('ana', 'Ana')
        const { ion, ana } = await pair()

        expect([ion.state, ana.state]).toEqual(['active', 'active'])
        expect([ion.relay.mode, ana.relay.mode]).toEqual(['polling', 'polling'])
        const from = mark()
        await settle(500)
        expect(since(from, 'ion', 'poll').length).toBeGreaterThan(5)
        expect(since(from, 'ana', 'poll').length).toBeGreaterThan(5)
        expect(ion.call.hub).toBeUndefined()
    })

    it('leaves a client without RelaySignaling exactly as it was on a backend that relays', async () => {
        const { ion, ana } = await pair({ ion: { relay: false }, ana: { relay: false } })

        expect([ion.state, ana.state]).toEqual(['active', 'active'])
        expect(ion.channelLabels).toEqual([])
        expect(ion.link.channels.size).toBe(0)
        const from = mark()
        await settle(500)
        expect(since(from, 'ana', 'poll').length).toBeGreaterThan(5)
    })
})

describe('what a peer may say over the channel', () => {
    it('takes a relayed signal and a view only from the hub', async () => {
        const { ion, ana } = await pair()
        const mihai = await add(ion, [ana], 'mihai')
        const toAna = mihai.topology.link('ana').channels.get(CHANNEL)

        // Mihai pretends to pass on a signal from Ion, and to be the hub.
        toAna.send(JSON.stringify({ t: 'signal', from: 'ion', type: 'state', payload: { muted: true } }))
        toAna.send(JSON.stringify({ t: 'view', data: { call: null }, reach: [] }))
        toAna.send(JSON.stringify({ t: 'poll' }))
        toAna.send('not json')
        const from = mark()
        await settle()

        expect(ana.peers.find((peer) => peer.id === 'ion').muted).toBe(false)
        expect(ana.state).toBe('active')
        expect(ana.relay.mode).toBe('quiet')
        expect(since(from, 'ana')).toEqual([])

        // In his own name he may.
        toAna.send(JSON.stringify({ t: 'signal', type: 'state', payload: { muted: true } }))
        await settle()
        expect(ana.peers.find((peer) => peer.id === 'mihai').muted).toBe(true)
    })

    it('does not pass signals on unless it is the hub', async () => {
        const { ion, ana } = await pair()
        const mihai = await add(ion, [ana], 'mihai')

        mihai.topology.link('ana').channels.get(CHANNEL).send(JSON.stringify({ t: 'signal', to: 'ion', type: 'state', payload: { muted: true } }))
        await settle()

        expect(ion.peers.find((peer) => peer.id === 'mihai').muted).toBe(false)
        expect(ana.relay.stats.relayed).toBe(0)
    })

    it('hands a signal back when the peer it is for is no longer within the hub\'s reach, and the sender posts it', async () => {
        const { ion, ana } = await pair()
        const mihai = await add(ion, [ana], 'mihai')
        // Ana and Mihai lose their own channel and the hub its channel to Mihai; Ana still thinks the hub reaches him.
        ana.topology.link('mihai').channels.get(CHANNEL).close()
        ion.topology.link('mihai').channels.get(CHANNEL).close()
        await settle()
        expect(mihai.relay.mode).toBe('polling')
        ana.relay.reach.add('mihai')
        const from = mark()

        ana.setMuted(true)
        await settle(300)

        expect(since(from, 'ana', 'send').map(([, , , type, to]) => [type, to])).toEqual([['state', 'mihai']])
        expect(mihai.peers.find((peer) => peer.id === 'ana').muted).toBe(true)
    })
})

describe('what the engine offers a signaling adapter', () => {
    it('applies a delivered answer like a polled one, and drops it for a call this window left', async () => {
        const { ion, ana, callId } = await pair({ ion: { relay: false }, ana: { relay: false } })

        await ana.deliver({ signals: [{ call: callId, type: 'state', payload: { cameraOff: true }, from: 'ion' }] }, { call: callId })
        expect(ana.peers[0].cameraOff).toBe(true)

        await ana.deliver({ signals: [{ call: callId, type: 'state', payload: { muted: true }, from: 'ion' }] }, { call: 'another' })
        expect(ana.peers[0].muted).toBe(false)

        await ana.hangUp()
        await ana.deliver({ call: { ...ion.call, joined: true }, signals: [] }, { call: callId })
        expect(ana.state).toBe('idle')
        expect(ana.call).toBe(null)
    })

    it('polls at once when asked to', async () => {
        const ion = client('ion', { relay: false, poll: { idle: 60000, active: 60000 } })
        ion.start()
        await settle(10)
        const from = mark()

        ion.pollNow()
        await settle(10)

        expect(since(from, 'ion', 'poll')).toHaveLength(1)
    })

    it('adds what a relaying window says to the poll of HttpSignaling', async () => {
        const urls = []
        const signaling = new HttpSignaling({
            routes: { poll: '/poll', store: '/', answer: '/a', decline: '/d', hangup: '/h', signal: '/s' },
            fetch: async (url) => { urls.push(url); return { ok: true, status: 200, text: async () => '{}' } },
        })

        await signaling.poll({ after: 3, call: 7, relay: true, present: ['ana', 'mihai'] })
        await signaling.poll({ after: 3 })

        expect(urls).toEqual(['/poll?after=3&call=7&relay=1&present=ana%2Cmihai', '/poll?after=3'])
    })
})
