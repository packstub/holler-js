import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CallClient, MeshTopology } from '../src/index.js'
import { FakeRTCPeerConnection, FakeServer, FakeTrack, installBrowserGlobals } from './fakes.js'

const EVENTS = ['statechange', 'incoming', 'update', 'localstream', 'remotestream', 'peers', 'peerjoined', 'peerleft', 'peerstate', 'ended', 'error']

let server

beforeEach(() => {
    vi.useFakeTimers()
    installBrowserGlobals()
    server = new FakeServer().name('ion', 'Ion').name('ana', 'Ana').name('mihai', 'Mihai').name('dana', 'Dana')
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

function client(user, options = {}) {
    const instance = new CallClient({ signaling: server.clientFor(user), poll: { idle: 100, active: 50 }, reconnectTimeout: 1000, ...options })
    instance.log = []
    for (const type of EVENTS) instance.addEventListener(type, (event) => instance.log.push({ type, ...event.detail }))
    instance.events = (type) => instance.log.filter((event) => event.type === type)
    instance.states = () => instance.events('statechange').map((event) => event.state)

    return instance
}

const settle = (ms = 150) => vi.advanceTimersByTimeAsync(ms)

/** The network comes up on every connection a client has. */
const connectAll = (...clients) => {
    for (const instance of clients) for (const link of instance.topology.links.values()) link.pc.setConnectionState('connected')
}

const signalsTo = (user, type) => server.sent(user).filter((signal) => signal.type === type)

/** Ion rings Ana and Mihai, both accept, every connection comes up. */
async function group(options = {}) {
    const ion = client('ion', options.ion)
    const ana = client('ana', options.ana)
    const mihai = client('mihai', options.mihai)
    for (const instance of [ion, ana, mihai]) instance.start()

    await ion.callUser(['ana', 'mihai'])
    await settle()
    await ana.accept()
    await settle()
    await mihai.accept()
    await settle()

    connectAll(ion, ana, mihai)
    await settle()

    return { ion, ana, mihai, callId: ion.call.id }
}

describe('a group call', () => {
    it('rings everyone at once: each invitee has a seat, and the caller\'s offers wait for them on the server', async () => {
        const ion = client('ion')
        const ana = client('ana')
        const mihai = client('mihai')
        for (const instance of [ion, ana, mihai]) instance.start()

        const call = await ion.callUser(['ana', 'mihai'])
        await settle()

        expect(call).toMatchObject({ status: 'ringing', role: 'caller', seat: 0, joined: true })
        expect(ion.peers.map(({ id, name, seat, status }) => ({ id, name, seat, status }))).toEqual([
            { id: 'ana', name: 'Ana', seat: 1, status: 'ringing' },
            { id: 'mihai', name: 'Mihai', seat: 2, status: 'ringing' },
        ])
        expect(ion.topology).toBeInstanceOf(MeshTopology)
        expect(ion.topology.links.size).toBe(2)
        expect(ana.state).toBe('ringing')
        expect(mihai.state).toBe('ringing')
        expect(ana.events('incoming')[0].call).toMatchObject({ role: 'callee', seat: 1, joined: false, peer: { name: 'Ion' } })
        expect(ana.peers.map(({ id, status }) => ({ id, status }))).toEqual([{ id: 'ion', status: 'joined' }, { id: 'mihai', status: 'ringing' }])
        // One offer per invitee, addressed to them.
        expect(server.log.filter(([, action, , type]) => action === 'send' && type === 'offer').map(([, , , , to]) => to)).toEqual(['ana', 'mihai'])
        expect(signalsTo('ana', 'offer')).toHaveLength(1)
        expect(signalsTo('mihai', 'offer')).toHaveLength(1)
    })

    it('connects everyone to everyone: the lower seat offers, and the call is active once media flows', async () => {
        const ion = client('ion')
        const ana = client('ana')
        const mihai = client('mihai')
        for (const instance of [ion, ana, mihai]) instance.start()

        await ion.callUser(['ana', 'mihai'])
        await settle()
        await ana.accept()
        await settle()

        // Ana (seat 1) answered Ion's offer and offered to Mihai (seat 2), who has not joined yet.
        expect(ana.topology.link('ion').polite).toBe(true)
        expect(ana.topology.link('mihai').polite).toBe(false)
        expect(ana.topology.link('ion').pc.localDescription.type).toBe('answer')
        expect(signalsTo('mihai', 'offer').map((signal) => signal.from)).toEqual(['ion', 'ana'])

        await mihai.accept()
        await settle()

        expect(mihai.topology.link('ion').polite).toBe(true)
        expect(mihai.topology.link('ana').polite).toBe(true)
        expect(mihai.topology.link('ion').pc.remoteDescription.type).toBe('offer')
        expect(mihai.topology.link('ana').pc.remoteDescription.type).toBe('offer')
        expect(ion.topology.link('mihai').pc.remoteDescription.type).toBe('answer')
        expect(ana.topology.link('mihai').pc.remoteDescription.type).toBe('answer')
        // Sessions are per connection: Mihai knows Ana's connection to him, not Ion's.
        expect(mihai.topology.link('ana').peerSession).toBe(ana.topology.link('mihai').session)
        expect(mihai.topology.link('ion').peerSession).toBe(ion.topology.link('mihai').session)

        connectAll(ion, ana, mihai)
        await settle()

        for (const instance of [ion, ana, mihai]) {
            expect(instance.state).toBe('active')
            expect(instance.peers.every((peer) => peer.status === 'joined' && peer.connected)).toBe(true)
        }
        expect(ion.states().slice(0, 2)).toEqual(['calling', 'connecting'])
        expect(ion.events('peerjoined').map((event) => event.peer.id)).toEqual(['ana', 'mihai'])
    })

    it('hands out one remote stream per peer, saying whose it is', async () => {
        const { ion } = await group()

        ion.topology.link('ana').pc.receiveTrack(new FakeTrack('audio'))
        ion.topology.link('mihai').pc.receiveTrack(new FakeTrack('audio'))
        ion.topology.link('mihai').pc.receiveTrack(new FakeTrack('video'))

        expect(ion.events('remotestream').map((event) => event.peer.id)).toEqual(['ana', 'mihai', 'mihai'])
        const mihai = ion.peers.find((peer) => peer.id === 'mihai')
        expect(mihai.stream.getVideoTracks()).toHaveLength(1)
        expect(ion.peers.find((peer) => peer.id === 'ana').stream.getTracks()).toHaveLength(1)
        expect(mihai.stream).not.toBe(ion.peers.find((peer) => peer.id === 'ana').stream)
    })

    it('tells everyone about a mute, and a peer who resets forgets only that peer\'s state', async () => {
        const { ion, ana, mihai } = await group()

        ion.setMuted(true)
        await settle()

        expect(ana.events('peerstate').at(-1)).toMatchObject({ peer: { id: 'ion' }, muted: true })
        expect(mihai.events('peerstate').at(-1)).toMatchObject({ peer: { id: 'ion' }, muted: true })
        expect(ana.peers.find((peer) => peer.id === 'ion').muted).toBe(true)
        expect(ana.peers.find((peer) => peer.id === 'mihai').muted).toBe(false)
        // The 1-on-1 conveniences point at the first peer.
        expect(ana.peer.id).toBe('ion')
        expect(ana.peerMuted).toBe(true)
    })

    it('goes on when one person declines, and ends for the caller only once nobody is left', async () => {
        const ion = client('ion')
        const ana = client('ana')
        const mihai = client('mihai')
        for (const instance of [ion, ana, mihai]) instance.start()

        await ion.callUser(['ana', 'mihai'])
        await settle()
        await mihai.decline()
        await settle()

        expect(ion.state).toBe('calling')
        expect(ion.events('peerleft')[0]).toMatchObject({ peer: { id: 'mihai' }, reason: 'declined' })
        expect(ion.peers.map((peer) => peer.id)).toEqual(['ana'])
        expect(ion.topology.links.has('mihai')).toBe(false)
        expect(FakeRTCPeerConnection.instances.filter((pc) => pc.closed)).toHaveLength(1)

        await ana.decline()
        await settle()

        expect(ion.state).toBe('idle')
        expect(ion.events('ended')[0].reason).toBe('declined')
    })

    it('keeps the call for the others when one person hangs up, and ends it when two are left and one leaves', async () => {
        const { ion, ana, mihai, callId } = await group()

        await mihai.hangUp()
        await settle()

        expect(mihai.state).toBe('idle')
        expect(server.calls.get(callId).status).toBe('active')
        expect(ion.state).toBe('active')
        expect(ana.state).toBe('active')
        expect(ion.events('peerleft')[0]).toMatchObject({ peer: { id: 'mihai' }, reason: 'left' })
        expect(ion.peers.map((peer) => peer.id)).toEqual(['ana'])
        expect(ana.topology.links.has('mihai')).toBe(false)

        await ana.hangUp()
        await settle()

        expect(server.calls.get(callId)).toMatchObject({ status: 'ended', end_reason: 'hung_up' })
        expect(ion.state).toBe('idle')
        expect(ion.events('ended')[0].reason).toBe('hung_up')
    })

    it('adds a person to a running call: the ones in it offer to the newcomer, who answers them all', async () => {
        const ion = client('ion')
        const ana = client('ana')
        const mihai = client('mihai')
        for (const instance of [ion, ana, mihai]) instance.start()
        await ion.callUser('ana')
        await settle()
        await ana.accept()
        await settle()
        connectAll(ion, ana)
        await settle()
        expect(ion.canInvite()).toBe(true)
        expect(ana.canInvite()).toBe(true)

        const call = await ion.invite('mihai')
        await settle()

        expect(call.peers.map(({ id, seat, status }) => ({ id, seat, status }))).toEqual([{ id: 'ana', seat: 1, status: 'joined' }, { id: 'mihai', seat: 2, status: 'ringing' }])
        expect(mihai.state).toBe('ringing')
        expect(mihai.events('incoming')[0].call).toMatchObject({ id: call.id, status: 'active', joined: false, seat: 2 })
        expect(ana.peers.map((peer) => peer.id)).toEqual(['ion', 'mihai'])
        expect(ana.topology.link('mihai').polite).toBe(false)
        expect(signalsTo('mihai', 'offer').map((signal) => signal.from).sort()).toEqual(['ana', 'ion'])
        // Nobody else was disturbed: Ion and Ana keep their connection.
        expect(ion.state).toBe('active')
        expect(ion.topology.link('ana').pc.closed).toBe(false)

        await mihai.accept()
        await settle()
        connectAll(ion, ana, mihai)
        await settle()

        expect(mihai.state).toBe('active')
        expect(mihai.peers.map((peer) => peer.id)).toEqual(['ion', 'ana'])
        expect(ion.topology.link('mihai').pc.remoteDescription.type).toBe('answer')
        expect(ana.topology.link('mihai').pc.remoteDescription.type).toBe('answer')
    })

    it('respects maxParticipants when calling and inviting, and the server\'s limits', async () => {
        const ion = client('ion')
        ion.start()

        await expect(ion.callUser(['ana', 'mihai', 'dana', 'someone'])).rejects.toMatchObject({ full: true })
        expect(server.calls.size).toBe(0)

        const { ion: caller, ana } = await group()
        expect(caller.canInvite()).toBe(true)
        await caller.invite('dana')
        await settle()
        expect(caller.canInvite()).toBe(false)
        await expect(caller.invite('someone')).rejects.toMatchObject({ full: true })

        // Not in the call yet (ringing): the server refuses an invite from there.
        const dana = client('dana')
        dana.start()
        await settle()
        expect(dana.state).toBe('ringing')
        await expect(dana.invite('someone')).rejects.toThrow('Not in a call.')
        expect(ana.canInvite()).toBe(false)
    })

    it('resets each peer separately after a page load, and the others stay active with each other', async () => {
        const { ion, ana, mihai, callId } = await group()
        ion.log.length = 0

        ana.leave()
        ana.stop()
        const reloaded = client('ana')
        reloaded.start()
        await settle()

        // Ion and Mihai each got a reset and an offer from Ana's new page, each with its own session.
        const toIon = server.sent('ion').filter((signal) => signal.from === 'ana' && signal.payload.session === reloaded.topology.link('ion').session)
        const toMihai = server.sent('mihai').filter((signal) => signal.from === 'ana' && signal.payload.session === reloaded.topology.link('mihai').session)
        expect(toIon.map((signal) => signal.type)).toEqual(['reset', 'offer'])
        expect(toMihai.map((signal) => signal.type)).toEqual(['reset', 'offer'])
        expect(reloaded.topology.link('ion').session).not.toBe(reloaded.topology.link('mihai').session)
        expect(server.participant(callId, 'ana').tab).toBe(reloaded.tab)

        // They rebuilt their side for Ana and answered; the call never left active, since Mihai is still there.
        expect(ion.topology.link('ana').polite).toBe(true)
        expect(ion.topology.link('ana').pc.remoteDescription.type).toBe('offer')
        expect(mihai.topology.link('ana').pc.remoteDescription.type).toBe('offer')
        expect(ion.states()).toEqual([])
        expect(ion.state).toBe('active')
        expect(ion.peers.find((peer) => peer.id === 'ana').connected).toBe(false)
        expect(ion.peers.find((peer) => peer.id === 'mihai').connected).toBe(true)

        connectAll(ion, mihai, reloaded)
        await settle()

        expect(reloaded.state).toBe('active')
        expect(ion.peers.every((peer) => peer.connected)).toBe(true)
    })

    it('stops ringing someone the server gave up on while the call goes on for the others', async () => {
        const ion = client('ion')
        const ana = client('ana')
        const mihai = client('mihai')
        for (const instance of [ion, ana, mihai]) instance.start()
        await ion.callUser(['ana', 'mihai'])
        await settle()
        await ana.accept()
        await settle()
        connectAll(ion, ana)
        await settle()
        expect(mihai.state).toBe('ringing')

        // The ring timeout passes for Mihai: the server marks him missed, Ion and Ana go on.
        const found = server.calls.get(ion.call.id)
        server.withdraw(found, server.participant(found.id, 'mihai'), 'missed')
        await settle()

        expect(ion.state).toBe('active')
        expect(ion.peers.map((peer) => peer.id)).toEqual(['ana'])
        expect(ion.events('peerleft')[0]).toMatchObject({ peer: { id: 'mihai' }, reason: 'missed' })
        expect(mihai.state).toBe('idle')
        expect(mihai.call).toBeNull()
        expect(mihai.events('ended')[0]).toMatchObject({ reason: 'missed' })
    })

    it('ignores an answer to an offer from before its page reloaded', async () => {
        const ion = client('ion')
        const ana = client('ana')
        const mihai = client('mihai')
        for (const instance of [ion, ana, mihai]) instance.start()
        await ion.callUser(['ana', 'mihai'])
        await settle()
        await ana.accept()
        await settle()
        connectAll(ion, ana)
        await settle()

        // Ion reloads while Mihai still rings: Mihai will find two offers from Ion, and a reset between them.
        ion.leave()
        ion.stop()
        const reloaded = client('ion')
        reloaded.start()
        await settle()
        expect(signalsTo('mihai', 'offer').filter((signal) => signal.from === 'ion')).toHaveLength(2)

        await mihai.accept()
        await settle()

        // Mihai answered both; only the answer to the new offer counts for the new page.
        const link = reloaded.topology.link('mihai')
        const answers = signalsTo('ion', 'answer').filter((signal) => signal.from === 'mihai')
        expect(answers.map((signal) => signal.payload.offer)).toContain(link.session)
        expect(link.peerSession).toBe(mihai.topology.link('ion').session)
        expect(link.pc.remoteDescription.type).toBe('answer')
        expect(reloaded.events('error')).toEqual([])

        connectAll(reloaded, ana, mihai)
        await settle()
        expect(mihai.state).toBe('active')
        expect(reloaded.peers.every((peer) => peer.connected)).toBe(true)
    })

    it('treats a peer invited again at a new seat as a new peer, even when their leaving was never seen', async () => {
        const { ion, ana, mihai, callId } = await group()
        const before = ion.topology.link('mihai')

        // Ion's window stops polling, so it misses Mihai leaving before Ion adds him back.
        ion.stop()
        await mihai.hangUp()
        await settle()
        expect(server.participant(callId, 'mihai').status).toBe('left')
        ion.log.length = 0

        const call = await ion.invite('mihai')
        expect(call.peers.find((peer) => peer.id === 'mihai')).toMatchObject({ seat: 3, status: 'ringing' })
        expect(ion.events('peerleft')[0]).toMatchObject({ peer: { id: 'mihai', seat: 2 } })
        expect(ion.peers.find((peer) => peer.id === 'mihai')).toMatchObject({ seat: 3, status: 'ringing', connected: false })
        expect(before.closed).toBe(true)
        expect(ion.topology.link('mihai')).not.toBe(before)
        expect(ion.topology.link('mihai').polite).toBe(false)

        ion.start()
        await settle()
        await mihai.accept()
        await settle()
        connectAll(ion, ana, mihai)
        await settle()
        expect(mihai.state).toBe('active')
        expect(mihai.topology.link('ion').polite).toBe(true)
        expect(ion.peers.every((peer) => peer.connected)).toBe(true)
    })

    it('stays active while one peer is quiet, and drops only once every peer is gone', async () => {
        const { ion, ana, mihai, callId } = await group()

        mihai.stop()
        server.participant(callId, 'mihai').tab = null
        server.tick(10)
        await settle()

        expect(ion.state).toBe('active')
        expect(ion.peers.find((peer) => peer.id === 'mihai').alive).toBe(false)

        ana.stop()
        server.participant(callId, 'ana').tab = null
        server.tick(10)
        await settle()

        expect(ion.state).toBe('reconnecting')
        await settle(1100)
        expect(ion.state).toBe('idle')
        expect(ion.events('ended')[0].reason).toBe('dropped')
    })
})

describe('topologies', () => {
    /** A topology that records what the client asks of it and never opens a connection. */
    class RecordingTopology {
        constructor() {
            this.calls = []
            this.connectedPeers = new Set()
        }

        attach(client) { this.client = client; this.calls.push(['attach']) }
        join(call) { this.calls.push(['join', call.id]) }
        connect(peer, options) { this.calls.push(['connect', peer.id, options]) }
        disconnect(peer) { this.calls.push(['disconnect', peer.id]); this.connectedPeers.delete(peer.id) }
        reset(peer) { this.calls.push(['reset', peer.id]) }
        signal(peer, type, payload, from) { this.calls.push(['signal', peer?.id ?? null, type, from]) }
        connected(peer) { return this.connectedPeers.has(peer.id) }
        replaceVideo(track) { this.calls.push(['replaceVideo', track?.label ?? null]) }
        leave() { this.calls.push(['leave']) }

        // What an SFU would do once media arrives.
        up(peerId, stream) {
            this.connectedPeers.add(peerId)
            const peer = this.client.roster.get(peerId)
            this.client.remoteStreamFrom(peer, stream)
            this.client.connectionChanged(peer, true)
        }
    }

    it('drives a custom topology through the interface, with the seat order as politeness', async () => {
        const topologies = []
        const factory = vi.fn((call, client) => {
            const topology = new RecordingTopology()
            topologies.push({ topology, call, client })
            return topology
        })
        const ion = client('ion', { topology: factory })
        const ana = client('ana', { topology: factory })
        const mihai = client('mihai', { topology: factory })
        for (const instance of [ion, ana, mihai]) instance.start()

        await ion.callUser(['ana', 'mihai'])
        await settle()
        await ana.accept()
        await settle()

        expect(factory).toHaveBeenCalledTimes(2)
        expect(topologies[0].call.peers).toHaveLength(2)
        expect(topologies[0].client).toBe(ion)
        expect(ion.topology.calls.slice(0, 4)).toEqual([
            ['attach'], ['join', 1], ['connect', 'ana', { polite: false }], ['connect', 'mihai', { polite: false }],
        ])
        expect(ana.topology.calls.slice(0, 4)).toEqual([
            ['attach'], ['join', 1], ['connect', 'ion', { polite: true }], ['connect', 'mihai', { polite: false }],
        ])
        // No RTCPeerConnection of ours, and no mesh conveniences.
        expect(FakeRTCPeerConnection.instances).toHaveLength(0)
        expect(ion.pc).toBeNull()
        expect(ion.link).toBeNull()

        // Signals from the server reach the topology with the sender.
        await server.clientFor('mihai').send(1, 'offer', { sdp: 'x' }, 'ana')
        await settle()
        expect(ana.topology.calls.at(-1)).toEqual(['signal', 'mihai', 'offer', 'mihai'])

        // The topology reports media: the call becomes active, the peer shows connected with a stream.
        ana.topology.up('ion', new MediaStream())
        await settle()
        expect(ana.state).toBe('active')
        expect(ana.peers.find((peer) => peer.id === 'ion')).toMatchObject({ connected: true })
        expect(ana.events('remotestream')[0].peer.id).toBe('ion')

        await ana.shareScreen()
        expect(ana.topology.calls.at(-1)).toEqual(['replaceVideo', 'screen'])

        await mihai.decline()
        await settle()
        expect(ana.topology.calls.filter(([method]) => method === 'disconnect')).toEqual([['disconnect', 'mihai']])

        await ana.hangUp()
        expect(ana.topology).toBeNull()
        expect(topologies[1].topology.calls.at(-1)).toEqual(['leave'])
    })

    it('resets a peer through the topology after that peer reloads', async () => {
        const ion = client('ion', { topology: () => new RecordingTopology() })
        const ana = client('ana')
        ion.start()
        ana.start()
        await ion.callUser('ana')
        await settle()
        await ana.accept()
        await settle()

        ana.leave()
        ana.stop()
        const reloaded = client('ana')
        reloaded.start()
        await settle()

        expect(ion.topology.calls.filter(([method]) => method === 'reset')).toEqual([['reset', 'ana']])
        expect(ion.topology.calls.at(-1)).toEqual(['signal', 'ana', 'offer', 'ana'])
        expect(reloaded.topology).toBeInstanceOf(MeshTopology)
    })

    it('takes a topology class or an instance as well as a factory', async () => {
        const shared = new MeshTopology()
        const ion = client('ion', { topology: MeshTopology })
        const ana = client('ana', { topology: shared })
        ion.start()
        ana.start()

        await ion.callUser('ana')
        await settle()
        await ana.accept()
        await settle()

        expect(ion.topology).toBeInstanceOf(MeshTopology)
        expect(ana.topology).toBe(shared)
        expect(shared.client).toBe(ana)
        expect(shared.links.size).toBe(1)

        await ana.hangUp()
        expect(shared.links.size).toBe(0)
        expect(ana.topology).toBeNull()
    })
})

describe('a 1-on-1 backend', () => {
    /** The signaling of a server that knows nothing about groups: no peers, seats or senders. */
    const oneOnOne = (user) => {
        const inner = server.clientFor(user)
        const strip = (call) => {
            if (! call) return call
            const { peers, seat, joined, ...rest } = call
            return rest
        }

        return {
            start: (callee, tab) => inner.start(callee, tab).then(strip),
            answer: (callId, tab) => inner.answer(callId, tab).then(strip),
            decline: (callId) => inner.decline(callId).then(strip),
            hangup: (callId) => inner.hangup(callId).then(strip),
            send: (callId, type, payload) => inner.send(callId, type, payload),
            leave: (callId, tab) => inner.leave(callId, tab),
            poll: (query) => inner.poll(query).then(({ call, incoming, signals, cursor }) => ({
                call: strip(call), incoming: strip(incoming), cursor,
                signals: signals.map(({ from, ...signal }) => signal),
            })),
        }
    }

    it('still connects: the peer, the seats and the sender are derived from the 1-on-1 fields', async () => {
        const ion = client('ion', { signaling: oneOnOne('ion') })
        const ana = client('ana', { signaling: oneOnOne('ana') })
        ion.start()
        ana.start()

        await ion.callUser('ana')
        await settle()

        expect(ion.seat).toBe(0)
        expect(ion.peers).toEqual([expect.objectContaining({ id: 'ana', name: 'Ana', seat: 1, status: 'ringing' })])
        expect(ana.state).toBe('ringing')
        expect(ana.peers).toEqual([expect.objectContaining({ id: 'ion', name: 'Ion', seat: 0, status: 'joined' })])

        await ana.accept()
        await settle()

        expect(ana.seat).toBe(1)
        expect(ana.polite).toBe(true)
        expect(ana.pc.remoteDescription.type).toBe('offer')
        expect(ion.pc.remoteDescription.type).toBe('answer')
        expect(ion.peers[0].status).toBe('joined')

        ion.pc.setConnectionState('connected')
        ana.pc.setConnectionState('connected')
        await settle()
        expect(ion.state).toBe('active')
        expect(ana.state).toBe('active')

        ion.setMuted(true)
        await settle()
        expect(ana.peerMuted).toBe(true)
        expect(ana.events('peerstate').at(-1).peer.id).toBe('ion')

        // No invite route: nobody can be added.
        expect(ion.canInvite()).toBe(false)
        await expect(ion.invite('mihai')).rejects.toThrow('cannot add people')
    })
})

describe('inviting from another window', () => {
    it('lets a tab whose pop-out runs the call add someone: the pop-out connects to the newcomer on its next poll', async () => {
        const ion = client('ion')
        const ana = client('ana')
        const mihai = client('mihai')
        for (const instance of [ion, ana, mihai]) instance.start()
        await ion.callUser('ana')
        await settle()
        await ana.accept()
        await settle()

        const chip = client('ion', { resumes: false })
        chip.start()
        await settle()
        expect(chip.state).toBe('elsewhere')
        expect(chip.canInvite()).toBe(true)

        await chip.invite('mihai')
        await settle()

        expect(chip.peers.map((peer) => peer.id)).toEqual(['ana', 'mihai'])
        expect(chip.topology).toBeNull()
        expect(ion.topology.link('mihai')).not.toBeNull()
        expect(mihai.state).toBe('ringing')

        // A tab that is itself being rung cannot add anyone.
        await expect(mihai.invite('dana')).rejects.toThrow('Not in a call.')
        expect(mihai.canInvite()).toBe(false)
    })

    it('ends for a watching tab when its pop-out leaves a call that goes on for the others', async () => {
        const { ion, ana, mihai, callId } = await group()
        const chip = client('mihai', { resumes: false })
        chip.start()
        await settle()
        expect(chip.state).toBe('elsewhere')

        await mihai.hangUp()
        await settle()

        expect(server.calls.get(callId).status).toBe('active')
        expect(chip.state).toBe('idle')
        expect(chip.events('ended')[0]).toMatchObject({ reason: 'hung_up', call: { id: callId } })
        expect(chip.events('incoming')).toHaveLength(0)
        expect(ion.state).toBe('active')
        expect(ana.state).toBe('active')
    })
})
