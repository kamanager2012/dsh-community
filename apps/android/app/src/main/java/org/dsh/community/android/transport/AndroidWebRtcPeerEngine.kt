package org.dsh.community.android.transport

import android.content.Context
import org.dsh.community.android.protocol.JsonCodec
import org.dsh.community.android.protocol.JsonNull
import org.dsh.community.android.protocol.JsonNumber
import org.dsh.community.android.protocol.JsonObject
import org.dsh.community.android.protocol.JsonString
import org.dsh.community.android.protocol.JsonValue
import org.webrtc.CandidatePairChangeEvent
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.IceCandidateErrorEvent
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Native Android `org.webrtc` DataChannel engine wired to `SelfHostedSignalingServer`
 * binary WebSocket signaling (`ws://` / `wss://`) and strictly self-owned STUN URLs
 * (`stun:` only; empty list runs local/host ICE without any public STUN fallback).
 */
class AndroidWebRtcPeerEngine(
    appContext: Context,
    private val connectTimeoutMs: Long = 10_000L,
    private val wsConnectTimeoutMs: Int = 5_000,
    private val maxFrameBytes: Int = 65_536,
    private val dataChannelLabel: String = "dsh-remote-v1",
) : WebRtcPeerEngine {

    private val appContext: Context = appContext.applicationContext

    override fun openDataChannel(
        signalingUrl: String,
        roomId: String,
        stunUrls: List<String>,
        callbacks: RemoteTransportCallbacks,
    ): WebRtcPeerHandle {
        val normalizedSignalingUrl = validateSignalingUrl(signalingUrl)
        val normalizedRoomId = validateRoomId(roomId)
        val validatedStunUrls = validateSelfOwnedStunUrls(stunUrls)
        val iceServers = validatedStunUrls.map { url ->
            PeerConnection.IceServer.builder(url).createIceServer()
        }

        val factory = getOrCreateFactory(appContext)
        val session = ActivePeerSession(
            factory = factory,
            signalingUrl = normalizedSignalingUrl,
            roomId = normalizedRoomId,
            iceServers = iceServers,
            connectTimeoutMs = connectTimeoutMs,
            wsConnectTimeoutMs = minOf(wsConnectTimeoutMs, maxOf(1_000, connectTimeoutMs.toInt())),
            maxFrameBytes = maxFrameBytes,
            dataChannelLabel = dataChannelLabel,
            callbacks = callbacks,
        )
        session.openBlocking()
        return session
    }

    private class ActivePeerSession(
        private val factory: PeerConnectionFactory,
        private val signalingUrl: String,
        private val roomId: String,
        private val iceServers: List<PeerConnection.IceServer>,
        private val connectTimeoutMs: Long,
        private val wsConnectTimeoutMs: Int,
        private val maxFrameBytes: Int,
        private val dataChannelLabel: String,
        private val callbacks: RemoteTransportCallbacks,
    ) : WebRtcPeerHandle {
        private val stateLock = Any()
        private val signalingSendLock = Any()
        private val sendLock = Any()
        private val openLatch = CountDownLatch(1)
        private val opened = AtomicBoolean(false)
        private val closed = AtomicBoolean(false)
        private val disposed = AtomicBoolean(false)
        private val failureRef = AtomicReference<Throwable?>(null)
        private val reassembler = DataChannelChunkCodec.Reassembler(maxFrameBytes)

        private var hostPeerId: String? = null
        private var offerSent = false
        private var remoteDescSet = false
        private val localIceQueue = ArrayList<JsonValue>()
        private val remoteIceQueue = ArrayList<IceCandidate>()

        @Volatile
        private var signalingWs: BinaryWebSocketClient? = null

        @Volatile
        private var peerConnection: PeerConnection? = null

        @Volatile
        private var dataChannel: DataChannel? = null

        fun openBlocking() {
            logWebRtc("openBlocking start stunServers=${iceServers.size} timeoutMs=$connectTimeoutMs")
            val ws = BinaryWebSocketClient(
                url = signalingUrl,
                connectTimeoutMs = wsConnectTimeoutMs,
                maxFrameBytes = maxFrameBytes,
                binaryOnly = true,
            )
            signalingWs = ws

            val pc = try {
                createPeerConnection()
            } catch (t: Throwable) {
                closed.set(true)
                cleanupAsync()
                throw TransportUnavailableException(
                    "WEBRTC_PEER_INIT_FAILED",
                    "failed to create Android PeerConnection: ${t.message}",
                    t,
                )
            }
            peerConnection = pc

            val dcInit = DataChannel.Init().apply {
                ordered = true
            }
            val dc = pc.createDataChannel(dataChannelLabel, dcInit)
            if (dc == null) {
                closed.set(true)
                cleanupAsync()
                throw TransportUnavailableException(
                    "WEBRTC_DC_INIT_FAILED",
                    "PeerConnection.createDataChannel returned null",
                )
            }
            dataChannel = dc
            dc.registerObserver(createDataChannelObserver(dc))

            try {
                ws.connectBlocking(createSignalingListener())
                sendSignalingJson(
                    ws,
                    JsonObject.of(
                        "v" to JsonNumber(1),
                        "type" to JsonString("client.join"),
                        "roomId" to JsonString(roomId),
                    ),
                )
                logWebRtc("signaling connected; sent client.join")
            } catch (t: Throwable) {
                logWebRtc("signaling connect/join failed: ${t.message}")
                closed.set(true)
                cleanupAsync()
                throw TransportUnavailableException(
                    "WEBRTC_SIGNALING_CONNECT_FAILED",
                    "failed to connect signaling $signalingUrl: ${t.message}",
                    t,
                )
            }

            val completed = try {
                openLatch.await(connectTimeoutMs, TimeUnit.MILLISECONDS)
            } catch (ie: InterruptedException) {
                Thread.currentThread().interrupt()
                closed.set(true)
                cleanupAsync()
                throw TransportUnavailableException(
                    "WEBRTC_INTERRUPTED",
                    "interrupted awaiting WebRTC DataChannel open",
                    ie,
                )
            }

            if (!completed) {
                logWebRtc(
                    "openLatch timeout after ${connectTimeoutMs}ms ice=${pc.iceConnectionState()} conn=${pc.connectionState()} dc=${dc.state()}",
                )
                closed.set(true)
                cleanupAsync()
                throw TransportUnavailableException(
                    "WEBRTC_TIMEOUT",
                    "WebRTC DataChannel open timed out after ${connectTimeoutMs}ms",
                )
            }

            val err = failureRef.get()
            if (err != null && !opened.get()) {
                logWebRtc("open failed before OPEN: ${err.message}")
                closed.set(true)
                cleanupAsync()
                if (err is IOException) throw err
                throw TransportUnavailableException(
                    "WEBRTC_CONNECT_FAILED",
                    err.message ?: "WebRTC connection failed",
                    err,
                )
            }

            if (!opened.get()) {
                logWebRtc("openLatch released without opened=true")
                closed.set(true)
                cleanupAsync()
                throw TransportUnavailableException(
                    "WEBRTC_CONNECT_FAILED",
                    "WebRTC DataChannel failed to reach OPEN state",
                )
            }
        }

        override fun sendBinary(payload: ByteArray) {
            if (closed.get()) {
                throw IOException("WebRTC DataChannel is closed")
            }
            val dc = dataChannel ?: throw IOException("WebRTC DataChannel is unavailable")
            if (dc.state() != DataChannel.State.OPEN) {
                throw IOException("WebRTC DataChannel is not OPEN (state=${dc.state()})")
            }
            if (payload.size > maxFrameBytes) {
                throw IOException("WebRTC payload (${payload.size}) exceeds maxFrameBytes ($maxFrameBytes)")
            }

            val chunks = DataChannelChunkCodec.encode(payload)
            synchronized(sendLock) {
                for (chunk in chunks) {
                    if (closed.get() || dc.state() != DataChannel.State.OPEN) {
                        throw IOException("WebRTC DataChannel closed mid-send")
                    }
                    val directBuf = ByteBuffer.allocateDirect(chunk.size)
                    directBuf.put(chunk)
                    directBuf.flip()
                    if (!dc.send(DataChannel.Buffer(directBuf, true))) {
                        throw IOException("WebRTC DataChannel.send returned false")
                    }
                }
            }
        }

        override fun isOpen(): Boolean =
            !closed.get() && opened.get() && dataChannel?.state() == DataChannel.State.OPEN

        override fun close(reason: String) {
            if (!closed.compareAndSet(false, true)) return
            failBeforeOpen(TransportUnavailableException("WEBRTC_CLOSED", reason))
            cleanupAsync()
        }

        private fun createPeerConnection(): PeerConnection {
            val config = PeerConnection.RTCConfiguration(iceServers).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                iceTransportsType = PeerConnection.IceTransportsType.ALL
            }
            return factory.createPeerConnection(
                config,
                object : PeerConnection.Observer {
                    override fun onSignalingChange(newState: PeerConnection.SignalingState?) {
                        logWebRtc("onSignalingChange state=$newState")
                    }

                    override fun onIceConnectionChange(newState: PeerConnection.IceConnectionState?) {
                        logWebRtc("onIceConnectionChange state=$newState")
                        if (newState == PeerConnection.IceConnectionState.FAILED ||
                            newState == PeerConnection.IceConnectionState.CLOSED
                        ) {
                            handleDrop("WebRTC ICE $newState", null)
                        }
                    }

                    override fun onStandardizedIceConnectionChange(newState: PeerConnection.IceConnectionState?) {
                        logWebRtc("onStandardizedIceConnectionChange state=$newState")
                    }

                    override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
                        logWebRtc("onConnectionChange state=$newState")
                        if (newState == PeerConnection.PeerConnectionState.FAILED ||
                            newState == PeerConnection.PeerConnectionState.CLOSED
                        ) {
                            handleDrop("WebRTC PeerConnection $newState", null)
                        }
                    }

                    override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit

                    override fun onIceGatheringChange(newState: PeerConnection.IceGatheringState?) {
                        logWebRtc("onIceGatheringChange state=$newState")
                        if (newState == PeerConnection.IceGatheringState.COMPLETE && !closed.get()) {
                            emitLocalIce(JsonNull)
                        }
                    }

                    override fun onIceCandidate(candidate: IceCandidate?) {
                        if (candidate == null || closed.get()) return
                        logWebRtc("local ICE candidate ${describeCandidate(candidate.sdp)}")
                        val candJson = JsonObject.of(
                            "candidate" to JsonString(candidate.sdp),
                            "sdpMid" to JsonString(candidate.sdpMid ?: "0"),
                            "sdpMLineIndex" to JsonNumber(candidate.sdpMLineIndex),
                        )
                        emitLocalIce(candJson)
                    }

                    override fun onIceCandidateError(event: IceCandidateErrorEvent?) {
                        if (event != null) {
                            logWebRtc(
                                "onIceCandidateError ${event.address.orEmpty()}:${event.port} code=${event.errorCode} text=${event.errorText.orEmpty()}",
                            )
                        }
                    }

                    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) = Unit

                    override fun onSelectedCandidatePairChanged(event: CandidatePairChangeEvent?) {
                        if (event != null) {
                            val localDesc = event.local?.sdp?.let(::describeCandidate) ?: "?"
                            val remoteDesc = event.remote?.sdp?.let(::describeCandidate) ?: "?"
                            logWebRtc(
                                "selectedPair local=($localDesc) remote=($remoteDesc) reason=${event.reason.orEmpty()}",
                            )
                        }
                    }

                    override fun onAddStream(stream: MediaStream?) = Unit
                    override fun onRemoveStream(stream: MediaStream?) = Unit
                    override fun onDataChannel(channel: DataChannel?) = Unit
                    override fun onRenegotiationNeeded() = Unit
                    override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) = Unit
                    override fun onRemoveTrack(receiver: RtpReceiver?) = Unit
                    override fun onTrack(transceiver: RtpTransceiver?) = Unit
                },
            ) ?: throw IOException("PeerConnectionFactory.createPeerConnection returned null")
        }

        private fun createDataChannelObserver(dc: DataChannel): DataChannel.Observer =
            object : DataChannel.Observer {
                override fun onBufferedAmountChange(previousAmount: Long) = Unit

                override fun onStateChange() {
                    val state = dc.state()
                    logWebRtc("DataChannel onStateChange state=$state closed=${closed.get()}")
                    if (closed.get()) return
                    when (state) {
                        DataChannel.State.OPEN -> {
                            if (opened.compareAndSet(false, true)) {
                                openLatch.countDown()
                                val ws = signalingWs
                                signalingWs = null
                                if (ws != null) {
                                    Thread({
                                        try {
                                            ws.close(1000, "DataChannel opened")
                                        } catch (_: Throwable) {
                                        }
                                    }, "dsh-webrtc-sig-close").apply {
                                        isDaemon = true
                                        start()
                                    }
                                }
                            }
                        }
                        DataChannel.State.CLOSING, DataChannel.State.CLOSED -> {
                            handleDrop("WebRTC DataChannel $state", null)
                        }
                        else -> Unit
                    }
                }

                override fun onMessage(buffer: DataChannel.Buffer?) {
                    if (buffer == null || closed.get()) return
                    if (!buffer.binary) {
                        handleDrop(
                            "text DataChannel frame forbidden",
                            TransportUnavailableException(
                                "WEBRTC_TEXT_FRAME_FORBIDDEN",
                                "rejected non-binary DataChannel frame",
                            ),
                        )
                        return
                    }
                    try {
                        val dup = buffer.data.duplicate()
                        val raw = ByteArray(dup.remaining())
                        dup.get(raw)
                        val assembled = reassembler.push(raw)
                        if (assembled != null) {
                            callbacks.onBinaryFrame(assembled)
                        }
                    } catch (t: Throwable) {
                        handleDrop("DataChannel chunk decode error: ${t.message}", t)
                    }
                }
            }

        private fun createSignalingListener(): BinaryWebSocketClient.Listener =
            object : BinaryWebSocketClient.Listener {
                override fun onOpen() = Unit

                override fun onBinaryMessage(payload: ByteArray) {
                    if (closed.get()) return
                    try {
                        val msg = JsonCodec.parseObject(String(payload, StandardCharsets.UTF_8))
                        when (val type = msg.str("type")) {
                            "client.joined" -> handleJoined(msg)
                            "rtc.answer" -> handleRemoteAnswer(msg)
                            "rtc.ice" -> handleRemoteIce(msg)
                            "host.offline" -> {
                                failBeforeOpen(
                                    TransportUnavailableException(
                                        "WEBRTC_HOST_OFFLINE",
                                        "host offline in signaling room",
                                    ),
                                )
                            }
                            "error" -> {
                                val code = msg.str("code") ?: "SIGNALING_ERROR"
                                val message = msg.str("message") ?: "signaling rejected client"
                                failBeforeOpen(
                                    TransportUnavailableException("WEBRTC_$code", message),
                                )
                            }
                            "pong" -> Unit
                            else -> Unit
                        }
                    } catch (t: Throwable) {
                        failBeforeOpen(
                            TransportUnavailableException(
                                "WEBRTC_SIGNALING_PROTOCOL_ERROR",
                                "invalid signaling frame: ${t.message}",
                                t,
                            ),
                        )
                    }
                }

                override fun onClose(code: Int, reason: String) {
                    if (!opened.get()) {
                        failBeforeOpen(
                            TransportUnavailableException(
                                "WEBRTC_SIGNALING_CLOSED",
                                "signaling closed before DataChannel opened ($code: $reason)",
                            ),
                        )
                    }
                }

                override fun onError(error: Throwable) {
                    if (!opened.get()) {
                        failBeforeOpen(
                            TransportUnavailableException(
                                "WEBRTC_SIGNALING_ERROR",
                                error.message ?: "signaling error",
                                error,
                            ),
                        )
                    }
                }
            }

        private fun handleJoined(msg: JsonObject) {
            val remoteHostPeerId = msg.str("hostPeerId")
            if (remoteHostPeerId.isNullOrBlank()) {
                failBeforeOpen(
                    TransportUnavailableException(
                        "WEBRTC_NO_HOST_PEER",
                        "client.joined missing hostPeerId",
                    ),
                )
                return
            }
            logWebRtc("client.joined received; creating offer")
            synchronized(stateLock) {
                hostPeerId = remoteHostPeerId
            }
            val pc = peerConnection ?: return
            pc.createOffer(
                object : SdpObserver {
                    override fun onCreateSuccess(sdp: SessionDescription?) {
                        if (sdp == null || closed.get()) return
                        logWebRtc("createOffer succeeded; calling setLocalDescription")
                        pc.setLocalDescription(
                            object : SdpObserver {
                                override fun onSetSuccess() {
                                    if (closed.get()) return
                                    synchronized(signalingSendLock) {
                                        val targetPeerId: String
                                        val bufferedLocalIce: List<JsonValue>
                                        synchronized(stateLock) {
                                            targetPeerId = hostPeerId ?: return
                                            offerSent = true
                                            bufferedLocalIce = localIceQueue.toList()
                                            localIceQueue.clear()
                                        }
                                        val ws = signalingWs ?: return
                                        try {
                                            sendSignalingJson(
                                                ws,
                                                JsonObject.of(
                                                    "v" to JsonNumber(1),
                                                    "type" to JsonString("rtc.offer"),
                                                    "roomId" to JsonString(roomId),
                                                    "toPeerId" to JsonString(targetPeerId),
                                                    "sdp" to JsonObject.of(
                                                        "type" to JsonString("offer"),
                                                        "sdp" to JsonString(sdp.description),
                                                    ),
                                                ),
                                            )
                                            for (cand in bufferedLocalIce) {
                                                sendIcePayload(ws, targetPeerId, cand)
                                            }
                                            logWebRtc("sent rtc.offer + queuedIce=${bufferedLocalIce.size}")
                                        } catch (t: Throwable) {
                                            failBeforeOpen(t)
                                        }
                                    }
                                }

                                override fun onSetFailure(error: String?) {
                                    logWebRtc("setLocalDescription failed: $error")
                                    failBeforeOpen(
                                        TransportUnavailableException(
                                            "WEBRTC_SET_LOCAL_SDP_FAILED",
                                            error ?: "setLocalDescription failed",
                                        ),
                                    )
                                }

                                override fun onCreateSuccess(p0: SessionDescription?) = Unit
                                override fun onCreateFailure(p0: String?) = Unit
                            },
                            sdp,
                        )
                    }

                    override fun onCreateFailure(error: String?) {
                        logWebRtc("createOffer failed: $error")
                        failBeforeOpen(
                            TransportUnavailableException(
                                "WEBRTC_CREATE_OFFER_FAILED",
                                error ?: "createOffer failed",
                            ),
                        )
                    }

                    override fun onSetSuccess() = Unit
                    override fun onSetFailure(p0: String?) = Unit
                },
                MediaConstraints(),
            )
        }

        private fun handleRemoteAnswer(msg: JsonObject) {
            val sdpObj = msg.obj("sdp")
            val sdpType = sdpObj?.str("type")
            val sdpText = sdpObj?.str("sdp")
            if (sdpType != "answer" || sdpText.isNullOrBlank()) {
                failBeforeOpen(
                    TransportUnavailableException(
                        "WEBRTC_INVALID_ANSWER",
                        "rtc.answer missing valid answer SDP",
                    ),
                )
                return
            }
            logWebRtc("rtc.answer received; calling setRemoteDescription")
            val pc = peerConnection ?: return
            pc.setRemoteDescription(
                object : SdpObserver {
                    override fun onSetSuccess() {
                        if (closed.get()) return
                        val pendingRemote: List<IceCandidate>
                        synchronized(stateLock) {
                            remoteDescSet = true
                            pendingRemote = remoteIceQueue.toList()
                            remoteIceQueue.clear()
                        }
                        logWebRtc("setRemoteDescription ok; applying queuedRemoteIce=${pendingRemote.size}")
                        for (ice in pendingRemote) {
                            try {
                                val added = pc.addIceCandidate(ice)
                                logWebRtc("addIceCandidate(queued ${describeCandidate(ice.sdp)})=$added")
                            } catch (t: Throwable) {
                                logWebRtc("addIceCandidate(queued) failed: ${t.message}")
                            }
                        }
                    }

                    override fun onSetFailure(error: String?) {
                        logWebRtc("setRemoteDescription failed: $error")
                        failBeforeOpen(
                            TransportUnavailableException(
                                "WEBRTC_SET_REMOTE_SDP_FAILED",
                                error ?: "setRemoteDescription failed",
                            ),
                        )
                    }

                    override fun onCreateSuccess(p0: SessionDescription?) = Unit
                    override fun onCreateFailure(p0: String?) = Unit
                },
                SessionDescription(SessionDescription.Type.ANSWER, sdpText),
            )
        }

        private fun handleRemoteIce(msg: JsonObject) {
            val candVal = msg.fields["candidate"] ?: return
            if (candVal is JsonNull) {
                logWebRtc("remote end-of-candidates received")
                return
            }
            val candObj = candVal as? JsonObject ?: return
            val candStr = candObj.str("candidate")
            if (candStr.isNullOrEmpty()) return
            val sdpMid = candObj.str("sdpMid") ?: "0"
            val sdpMLineIndex = candObj.intVal("sdpMLineIndex") ?: 0
            val candidate = IceCandidate(sdpMid, sdpMLineIndex, candStr)

            var canAddImmediately = false
            synchronized(stateLock) {
                if (!remoteDescSet) {
                    remoteIceQueue.add(candidate)
                } else {
                    canAddImmediately = true
                }
            }
            if (canAddImmediately && !closed.get()) {
                try {
                    val added = peerConnection?.addIceCandidate(candidate)
                    logWebRtc("addIceCandidate(live ${describeCandidate(candStr)})=$added")
                } catch (t: Throwable) {
                    logWebRtc("addIceCandidate(live) failed: ${t.message}")
                }
            } else if (!closed.get()) {
                logWebRtc("queued remote ICE ${describeCandidate(candStr)}")
            }
        }

        private fun emitLocalIce(candidateJson: JsonValue) {
            synchronized(signalingSendLock) {
                var readyTarget: String? = null
                synchronized(stateLock) {
                    val target = hostPeerId
                    if (!offerSent || target == null) {
                        localIceQueue.add(candidateJson)
                    } else {
                        readyTarget = target
                    }
                }
                val peerId = readyTarget ?: return
                val ws = signalingWs ?: return
                try {
                    sendIcePayload(ws, peerId, candidateJson)
                } catch (_: Throwable) {
                }
            }
        }

        private fun sendIcePayload(ws: BinaryWebSocketClient, toPeerId: String, candidateJson: JsonValue) {
            sendSignalingJson(
                ws,
                JsonObject.of(
                    "v" to JsonNumber(1),
                    "type" to JsonString("rtc.ice"),
                    "roomId" to JsonString(roomId),
                    "toPeerId" to JsonString(toPeerId),
                    "candidate" to candidateJson,
                ),
            )
        }

        private fun sendSignalingJson(ws: BinaryWebSocketClient, payload: JsonObject) {
            ws.sendBinary(payload.stringify().toByteArray(StandardCharsets.UTF_8))
        }

        private fun failBeforeOpen(error: Throwable) {
            if (!opened.get()) {
                if (failureRef.compareAndSet(null, error)) {
                    logWebRtc("failBeforeOpen: ${error.message}")
                }
                openLatch.countDown()
            }
        }

        private fun handleDrop(reason: String, error: Throwable?) {
            if (!opened.get()) {
                failBeforeOpen(error ?: TransportUnavailableException("WEBRTC_CONNECT_FAILED", reason))
                return
            }
            if (!closed.compareAndSet(false, true)) return
            logWebRtc("handleDrop after OPEN: $reason (${error?.message})")
            cleanupAsync()
            if (error != null) {
                callbacks.onError(error)
            } else {
                callbacks.onClosed(reason)
            }
        }

        private fun cleanupAsync() {
            if (!disposed.compareAndSet(false, true)) return
            val ws = signalingWs
            signalingWs = null
            val dc = dataChannel
            dataChannel = null
            val pc = peerConnection
            peerConnection = null

            Thread({
                try {
                    ws?.close(1000, "webrtc cleanup")
                } catch (_: Throwable) {
                }
                try {
                    dc?.unregisterObserver()
                    dc?.close()
                } catch (_: Throwable) {
                }
                try {
                    pc?.close()
                } catch (_: Throwable) {
                }
                try {
                    dc?.dispose()
                } catch (_: Throwable) {
                }
                try {
                    pc?.dispose()
                } catch (_: Throwable) {
                }
            }, "dsh-webrtc-dispose").apply {
                isDaemon = true
                start()
            }
        }
    }

    companion object {
        private val STUN_URL_RE = Regex("^stun:[^\\s]+$", RegexOption.IGNORE_CASE)
        private val SIGNALING_URL_RE = Regex("^wss?://[^\\s]+$", RegexOption.IGNORE_CASE)
        private val factoryLock = Any()

        @Volatile
        private var sharedFactory: PeerConnectionFactory? = null

        fun validateSignalingUrl(signalingUrl: String): String {
            val normalized = signalingUrl.trim()
            if (!SIGNALING_URL_RE.matches(normalized)) {
                throw TransportUnavailableException(
                    "WEBRTC_INVALID_SIGNALING",
                    "invalid WebRTC signalingUrl '$signalingUrl'",
                )
            }
            return normalized
        }

        fun validateRoomId(roomId: String): String {
            val normalized = roomId.trim()
            if (normalized.isEmpty()) {
                throw TransportUnavailableException(
                    "WEBRTC_INVALID_ROOM",
                    "WebRTC signaling roomId must not be empty",
                )
            }
            return normalized
        }

        fun validateSelfOwnedStunUrls(stunUrls: List<String>): List<String> {
            val out = ArrayList<String>(stunUrls.size)
            for (raw in stunUrls) {
                val trimmed = raw.trim()
                if (trimmed.isEmpty()) continue
                if (!STUN_URL_RE.matches(trimmed)) {
                    throw TransportUnavailableException(
                        "WEBRTC_INVALID_STUN",
                        "invalid STUN URL '$raw'; only self-owned stun: URLs are permitted",
                    )
                }
                out.add(trimmed)
            }
            return out
        }

        private fun getOrCreateFactory(context: Context): PeerConnectionFactory {
            sharedFactory?.let { return it }
            synchronized(factoryLock) {
                sharedFactory?.let { return it }
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions
                        .builder(context.applicationContext)
                        .createInitializationOptions(),
                )
                val factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
                sharedFactory = factory
                return factory
            }
        }
    }
}

private const val LOG_TAG = "DshWebRtc"

private fun logWebRtc(message: String) {
    try {
        android.util.Log.i(LOG_TAG, message)
    } catch (_: Throwable) {
        // Allow JVM unit tests where android.util.Log is not mocked.
    }
}

private fun describeCandidate(sdpLine: String): String {
    val parts = sdpLine.trim().split(Regex("\\s+"))
    if (parts.size < 8) return "malformed(${parts.size})"
    val proto = parts[2]
    val ip = parts[4]
    val port = parts[5]
    val typIdx = parts.indexOf("typ")
    val candType = if (typIdx >= 0 && typIdx + 1 < parts.size) parts[typIdx + 1] else "?"
    return "$proto $ip:$port typ=$candType"
}
