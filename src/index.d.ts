// Type declarations for @packstub/holler: the public API the README documents.
// Methods the README marks as internal are left out on purpose.

export type UserId = string | number

export type CallState = 'idle' | 'calling' | 'ringing' | 'connecting' | 'active' | 'reconnecting' | 'waiting' | 'elsewhere'

export type EndReason = 'declined' | 'cancelled' | 'missed' | 'hung_up' | 'failed' | 'dropped' | 'busy' | 'signed_out'

export type ParticipantStatus = 'ringing' | 'joined' | 'on_hold' | 'left' | 'declined' | 'missed' | 'dropped'

export type SignalType = 'offer' | 'answer' | 'ice' | 'reset' | 'state'

export type MediaKind = 'video' | 'audio' | 'none'

export type ConnectionQuality = 'good' | 'fair' | 'poor'

export type DeviceKind = 'microphone' | 'camera' | 'speaker'

/** The chosen devices by id; null is the system default. */
export type SelectedDevices = Record<DeviceKind, string | null>

export interface DeviceOption {
    id: string
    /** Empty until the person has allowed the camera or the microphone. */
    label: string
}

export interface DeviceList {
    microphones: DeviceOption[]
    cameras: DeviceOption[]
    /** Empty where the browser cannot pick a speaker. */
    speakers: DeviceOption[]
    selected: SelectedDevices
}

/** How a connection is doing: the round trip in milliseconds, the share of packets lost since the last look, the jitter in seconds, whether a TURN relay carries it. */
export interface ConnectionStats {
    rtt: number | null
    loss: number
    jitter: number | null
    relayed: boolean
    quality: ConnectionQuality
}

/** Another participant as the server describes them. */
export interface CallPeer {
    id: string
    name: string
    avatar: string | null
    seat: number
    status: ParticipantStatus
    claimed?: boolean
    seen_ago?: number | null
    /** Relayed signaling: this participant is the hub, the one window that polls for the others. */
    hub?: boolean
    /** Relayed signaling: their window takes signaling over a data channel (null: it has not said yet). */
    relay?: boolean | null
}

/** Someone the people search found. */
export interface Person {
    id: string
    name: string
    avatar: string | null
}

/** A call as the server returns it from `poll`, `start`, `answer` and the rest. */
export interface Call {
    id: string | number
    kind?: string
    status: 'ringing' | 'active' | 'ended'
    end_reason: string | null
    role: 'caller' | 'callee'
    seat?: number
    joined?: boolean
    /** I put this call on hold: still on it, away until I resume. */
    on_hold?: boolean
    peers?: CallPeer[]
    answered_at: string | null
    /** Another window of mine (a pop-out) has claimed my side of this call. */
    claimed_elsewhere?: boolean
    peer?: CallPeer | null
    peer_claimed?: boolean
    peer_seen_ago?: number | null
    /** Relayed signaling: I am the hub of this call. */
    hub?: boolean
    [key: string]: unknown
}

export interface Signal {
    /** Absent on a signal that did not come from the backend (`deliver()`). */
    id?: number
    call: string | number
    type: SignalType | string
    payload: Record<string, unknown>
    from?: string
}

export interface PollResult {
    call: Call | null
    incoming: Call | null
    /** The call I put on hold, if any. */
    on_hold?: Call | null
    signals: Signal[]
    cursor: number
    /** For the hub of relayed signaling: what to pass on to the peers it named as `present`. */
    relay?: RelayAnswer
}

/** What a hub's poll brings back for the peers connected to it. */
export interface RelayAnswer {
    /** By peer id: what that peer's own poll would have answered (`call`, `on_hold`, and anything else the backend adds). */
    views?: Record<string, Partial<PollResult> & Record<string, unknown>>
    /** The peers with signals waiting on the backend: each is told to poll once. */
    pending?: string[]
}

export interface PollOptions {
    after?: number
    call?: Call['id'] | null
    tab?: string | null
    claim?: boolean
    kind?: string | null
    /** From `RelaySignaling`: this window takes signaling over a data channel. */
    relay?: boolean
    /** From `RelaySignaling`, the hub only: the peers connected to it, whose side the backend keeps alive. */
    present?: string[] | null
}

export interface RtcConfiguration {
    iceServers: RTCIceServer[]
    iceTransportPolicy?: RTCIceTransportPolicy
}

/** A failed signaling request: `status` is the HTTP status, `reason` the server's word for it. */
export interface SignalingError extends Error {
    status?: number
    reason?: 'busy' | 'not_ringing' | 'not_allowed' | 'full' | 'ended' | 'too_large' | 'too_many' | 'invalid_response' | string
}

/** What a signaling backend implements; `HttpSignaling` maps it onto Holler for Laravel's routes. */
export interface Signaling {
    start(callees: UserId | UserId[], tab: string): Promise<Call>
    answer(callId: Call['id'], tab: string): Promise<Call>
    decline(callId: Call['id']): Promise<Call>
    hangup(callId: Call['id']): Promise<Call>
    invite?(callId: Call['id'], userId: UserId): Promise<Call>
    hold?(callId: Call['id']): Promise<Call>
    resume?(callId: Call['id'], tab?: string | null): Promise<Call>
    people?(query?: string, callId?: Call['id'] | null): Promise<{ people: Person[] } | Person[]>
    send(callId: Call['id'], type: SignalType | string, payload: Record<string, unknown>, to?: UserId | null): Promise<unknown>
    poll(options: PollOptions): Promise<PollResult>
    leave?(callId: Call['id'], tab: string): void
    configuration?(): Promise<RtcConfiguration>
    /** Called once by the `CallClient` this adapter is given to, for an adapter that works with the call itself. */
    attach?(client: CallClient): void
    /** Called by `destroy()`. */
    detach?(client: CallClient): void
}

export interface HttpSignalingRoutes {
    poll: string
    store: string
    answer: string
    decline: string
    hangup: string
    signal: string
    leave?: string
    invite?: string
    hold?: string
    resume?: string
    people?: string
    ice?: string
}

export interface HttpSignalingOptions {
    routes: HttpSignalingRoutes
    headers?: Record<string, string>
    beaconFields?: Record<string, string>
    kind?: string | null
    timeout?: number
    fetch?: typeof fetch
}

export class HttpSignaling implements Signaling {
    constructor(options: HttpSignalingOptions)
    /** Sent with every request; change it to carry a fresh CSRF token. */
    headers: Record<string, string>
    routes: HttpSignalingRoutes
    kind: string | null
    start(callees: UserId | UserId[], tab: string): Promise<Call>
    answer(callId: Call['id'], tab: string): Promise<Call>
    decline(callId: Call['id']): Promise<Call>
    hangup(callId: Call['id']): Promise<Call>
    invite(callId: Call['id'], userId: UserId): Promise<Call>
    hold(callId: Call['id']): Promise<Call>
    resume(callId: Call['id'], tab?: string | null): Promise<Call>
    people(query?: string, callId?: Call['id'] | null): Promise<{ people: Person[] }>
    send(callId: Call['id'], type: SignalType | string, payload: Record<string, unknown>, to?: UserId | null): Promise<unknown>
    poll(options?: PollOptions): Promise<PollResult>
    leave(callId: Call['id'], tab: string): void
    configuration(): Promise<RtcConfiguration>
}

export type RelayMode = 'polling' | 'quiet' | 'hub'

export interface RelaySignalingOptions {
    /** The label of the data channel signaling travels over; the same for everyone on the call. Default `holler:relay`. */
    channel?: string
    /** Milliseconds a signal waits for its peer to reach the hub before it goes over the backend (10000). */
    patience?: number
    /** Milliseconds the hub may be silent before this window polls again (10000): more than twice the hub's slowest poll. */
    hubTimeout?: number
    /** Characters a signal may have to go over a channel (60000); a larger one goes over the backend. */
    maxMessage?: number
}

export interface RelaySignalingEventMap {
    modechange: CustomEvent<{ mode: RelayMode }>
}

/**
 * Signaling over the call's data channels, around another adapter: the hub (named by the
 * backend) polls, everyone connected to it stops polling and falls back to the backend
 * whenever the hub is not there.
 */
export class RelaySignaling extends EventTarget implements Signaling {
    constructor(upstream: Signaling, options?: RelaySignalingOptions)
    readonly upstream: Signaling
    /** `hub`: this window polls for the others; `quiet`: it lives off what the hub passes on; `polling`: it asks the backend itself. */
    readonly mode: RelayMode
    readonly quiet: boolean
    /** Requests made to the backend (`polls`, `posts`), polls answered without one (`spared`), signals sent over a channel (`direct`, `viaHub`) and passed on as the hub (`relayed`). */
    readonly stats: { polls: number, spared: number, posts: number, direct: number, viaHub: number, relayed: number }
    start(callees: UserId | UserId[], tab: string): Promise<Call>
    answer(callId: Call['id'], tab: string): Promise<Call>
    decline(callId: Call['id']): Promise<Call>
    hangup(callId: Call['id']): Promise<Call>
    invite(callId: Call['id'], userId: UserId): Promise<Call>
    hold(callId: Call['id']): Promise<Call>
    resume(callId: Call['id'], tab?: string | null): Promise<Call>
    people(query?: string, callId?: Call['id'] | null): Promise<{ people: Person[] } | Person[]>
    send(callId: Call['id'], type: SignalType | string, payload: Record<string, unknown>, to?: UserId | null): Promise<unknown>
    poll(options?: PollOptions): Promise<PollResult>
    leave(callId: Call['id'], tab: string): void
    configuration(): Promise<RtcConfiguration>
    attach(client: CallClient): void
    detach(client: CallClient): void

    addEventListener<K extends keyof RelaySignalingEventMap>(type: K, listener: (event: RelaySignalingEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void
    removeEventListener<K extends keyof RelaySignalingEventMap>(type: K, listener: (event: RelaySignalingEventMap[K]) => void, options?: boolean | EventListenerOptions): void
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void
}

/** A participant on the roster: what the server says, what they told us, what the topology gives. */
export interface Peer {
    id: string
    name: string
    avatar: string | null
    seat: number
    status: ParticipantStatus
    alive: boolean
    connected: boolean
    /** Null until the connection is measured, and while it is down. */
    quality: ConnectionQuality | null
    muted: boolean
    cameraOff: boolean
    sharing: boolean
    stream: MediaStream | null
}

/** What a topology may use from the client. */
export interface TopologyHost {
    iceServers: RTCIceServer[]
    iceTransportPolicy: RTCIceTransportPolicy
    channelLabels: string[]
    readonly seat: number
    localSource(): MediaStream | null
    send(type: string, payload: Record<string, unknown>, to?: string | null): void
    remoteStreamFrom(peer: Peer, stream: MediaStream): void
    connectionChanged(peer: Peer, connected: boolean): void
    negotiated(peer: Peer): void
    emit(type: 'error', detail: { error: unknown }): void
}

/** How media travels between participants: `MeshTopology`, or an SFU adapter of your own. */
export interface Topology {
    attach(client: TopologyHost): void
    join?(call: Call): void
    connect(peer: Peer, options: { polite: boolean, reset?: boolean }): void
    disconnect(peer: Peer): void
    reset?(peer: Peer, payload: Record<string, unknown>): void
    stale?(peer: Peer, payload: Record<string, unknown>): boolean
    signal(peer: Peer | null, type: string, payload: Record<string, unknown>, from?: string): void | Promise<void>
    connected(peer: Peer): boolean
    replaceVideo?(track: MediaStreamTrack | null): void | Promise<void>
    addTracks?(stream: MediaStream): void | Promise<void>
    channel?(peer: Peer, label: string): RTCDataChannel | null
    stats?(peer: Peer): Promise<ConnectionStats | null> | ConnectionStats | null
    leave(): void
}

export class MeshTopology implements Topology {
    constructor()
    attach(client: TopologyHost): void
    connect(peer: Peer, options: { polite: boolean, reset?: boolean }): void
    disconnect(peer: Peer): void
    signal(peer: Peer | null, type: string, payload: Record<string, unknown>, from?: string): Promise<void>
    connected(peer: Peer): boolean
    channel(peer: Peer, label: string): RTCDataChannel | null
    stats(peer: Peer): Promise<ConnectionStats | null> | null
    /** The peer rebuilt their side (a `reset` signal): a new connection, answering theirs. */
    reset(peer: Peer): void
    /** Whether a `state` signal comes from an older connection of the peer's. */
    stale(peer: Peer, payload: Record<string, unknown>): boolean
    /** The screen in place of the camera on every connection (null: nothing). */
    replaceVideo(track: MediaStreamTrack | null): Promise<void> | void
    /** Media turned on during the call: sent to every peer. */
    addTracks(source: MediaStream | null): void
    leave(): void
}

export interface CallClientOptions {
    signaling: Signaling
    iceServers?: RTCIceServer[] | (() => RTCIceServer[] | Promise<RTCIceServer[]>)
    video?: boolean
    poll?: { idle?: number, active?: number, hidden?: number }
    media?: MediaKind | null
    channels?: string[]
    iceTransportPolicy?: RTCIceTransportPolicy
    reconnectTimeout?: number
    resumes?: boolean
    maxParticipants?: number
    topology?: Topology | (new () => Topology) | ((call: Call, client: CallClient) => Topology) | null
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
    devices?: Partial<SelectedDevices>
    enumerateDevices?: () => Promise<MediaDeviceInfo[]>
    /** Milliseconds between looks at each connection's quality (3000); 0 turns it off. */
    statsInterval?: number
}

export interface CallClientEventMap {
    statechange: CustomEvent<{ state: CallState }>
    incoming: CustomEvent<{ call: Call }>
    update: CustomEvent<{ call: Call }>
    localstream: CustomEvent<{ stream: MediaStream }>
    remotestream: CustomEvent<{ stream: MediaStream, peer: Peer }>
    peers: CustomEvent<{ peers: Peer[] }>
    peerjoined: CustomEvent<{ peer: Peer }>
    peerleft: CustomEvent<{ peer: Peer, reason: 'left' | 'declined' | 'missed' | 'dropped' }>
    peerstate: CustomEvent<{ peer: Peer, muted: boolean, cameraOff: boolean, sharing: boolean }>
    peerheld: CustomEvent<{ peer: Peer, onHold: boolean }>
    held: CustomEvent<{ call: Call | null }>
    datachannel: CustomEvent<{ peer: Peer, channel: RTCDataChannel, label: string }>
    quality: CustomEvent<{ peer: Peer } & ConnectionStats>
    devices: CustomEvent<{ selected: SelectedDevices }>
    ended: CustomEvent<{ call: Call | null, reason: EndReason | string }>
    error: CustomEvent<{ error: SignalingError | Error, media?: boolean }>
}

export class CallClient extends EventTarget {
    constructor(options: CallClientOptions)

    readonly state: CallState
    readonly call: Call | null
    /** The call I put on hold, from any window of mine. */
    readonly heldCall: Call | null
    readonly peers: Peer[]
    readonly peer: Peer | null
    readonly localStream: MediaStream | null
    readonly cameraStream: MediaStream | null
    readonly screenStream: MediaStream | null
    readonly muted: boolean
    readonly cameraOff: boolean
    readonly sharing: boolean
    readonly tab: string
    readonly peerMuted: boolean
    readonly peerCameraOff: boolean
    readonly peerSharing: boolean
    readonly remoteStream: MediaStream | null
    readonly selected: SelectedDevices
    /** The worst connection among the peers; null before anything is measured. */
    readonly quality: ConnectionQuality | null

    start(): void
    stop(): void
    destroy(): void
    callUser(users: UserId | UserId[]): Promise<Call>
    accept(): Promise<void>
    decline(): Promise<void>
    invite(userId: UserId): Promise<Call>
    canInvite(): boolean
    /** Step out of the call without leaving it; `resumeHeld()` comes back. */
    hold(): Promise<Call>
    canHold(): boolean
    resumeHeld(): Promise<Call | null>
    endHeld(): Promise<void>
    /** Who can be added to the call I am in (or rung) for what was typed. */
    search(query?: string): Promise<Person[]>
    hangUp(): Promise<void>
    setMuted(muted: boolean): void
    setCameraOff(off: boolean): void
    shareScreen(): Promise<void>
    stopSharing(): Promise<void>
    startMedia(kind?: 'audio' | 'video'): Promise<MediaStream | null>
    channel(label: string, peerId?: string | null): RTCDataChannel | null
    devices(): Promise<DeviceList>
    setDevice(kind: DeviceKind, id: string | null): Promise<void>
    measure(): Promise<Array<{ peer: Peer } & ConnectionStats>>
    resumeCall(callId?: Call['id'] | null, options?: { answer?: boolean }): void
    handOff(): void
    takeOver(): Promise<boolean>
    leave(): void
    /** Ask the backend now instead of at the next interval. */
    pollNow(): void
    /** Apply what a poll would have answered, handed over by a signaling adapter that is pushed to. With `call`, dropped unless this window is still on that call. */
    deliver(data: Partial<PollResult>, options?: { call?: Call['id'] | null }): Promise<void>

    addEventListener<K extends keyof CallClientEventMap>(type: K, listener: (event: CallClientEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void
    removeEventListener<K extends keyof CallClientEventMap>(type: K, listener: (event: CallClientEventMap[K]) => void, options?: boolean | EventListenerOptions): void
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void
}

/** Resolves once the channel's send buffer has room again; await it before each large message. */
export function drain(channel: RTCDataChannel): Promise<void>
/** A connection in a word, from its round trip (ms) and the share of packets lost. */
export function rateConnection(stats?: { rtt?: number | null, loss?: number | null }): ConnectionQuality
