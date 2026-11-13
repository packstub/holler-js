// Compiled by `npm run test:types` (tsc --noEmit): the README's examples against the declarations.
import { CallClient, HttpSignaling, MeshTopology, drain, type Peer, type Topology } from '@packstub/holler'
import { CallWidget, escape, safeUrl, templates } from '@packstub/holler/widget'

const signaling = new HttpSignaling({
    routes: { poll: '/calls/poll', store: '/calls', answer: '/calls/__ID__/answer', decline: '/calls/__ID__/decline', hangup: '/calls/__ID__/hangup', signal: '/calls/__ID__/signals', ice: '/calls/ice-servers' },
    headers: { 'X-CSRF-TOKEN': 'token' },
    kind: 'call',
})

const client = new CallClient({
    signaling,
    iceServers: () => signaling.configuration().then((rtc) => rtc.iceServers),
    poll: { idle: 5000, active: 1000 },
    media: 'none',
    channels: ['assist'],
    topology: (call) => (call.peers?.length ?? 0) > 3 ? new MeshTopology() : new MeshTopology(),
})

client.addEventListener('incoming', ({ detail: { call } }) => console.log(call.peer?.name))
client.addEventListener('remotestream', ({ detail: { stream, peer } }) => console.log(stream.id, peer.seat))
client.addEventListener('ended', ({ detail: { reason } }) => console.log(reason))
client.addEventListener('error', ({ detail: { error } }) => console.log('reason' in error ? error.reason : error.message))
client.addEventListener('datachannel', async ({ detail: { channel } }) => {
    await drain(channel)
    channel.send('hello')
})

async function run(): Promise<void> {
    client.start()
    await client.callUser([1, 'ana'])
    await client.accept()
    if (client.canInvite()) await client.invite(2)
    client.setMuted(true)
    await client.shareScreen()
    await client.startMedia('audio')
    const peers: Peer[] = client.peers
    console.log(peers.length, client.state, client.channel('assist'))
    await client.hangUp()
    client.destroy()
}

const custom: Topology = new MeshTopology()

const widget = new CallWidget({
    routes: { poll: '/calls/poll', store: '/calls', answer: '/a', decline: '/d', hangup: '/h', signal: '/s' },
    csrf: 'token',
    windowUrl: '/calls/window?call=__ID__&callee=__USER__',
    labels: { incoming: 'te sună' },
    templates: { notice: (model) => `<div>${escape(model.notice)}</div>` },
    startPolling: false,
})
widget.start()
widget.toggleMute()
console.log(safeUrl('https://example.com/a.png'), templates.tile, widget.model().names, run, custom)
