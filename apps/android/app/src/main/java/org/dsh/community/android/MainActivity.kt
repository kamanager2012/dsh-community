package org.dsh.community.android

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import org.dsh.community.android.protocol.OfficialSessionEvent
import org.dsh.community.android.protocol.SessionRef
import org.dsh.community.android.service.RemoteSessionService
import org.dsh.community.android.transport.DiscoveredLanHost
import org.dsh.community.android.transport.LanMdnsDiscoverer
import org.dsh.community.android.transport.RemoteConnectionPhase
import org.dsh.community.android.transport.TransportKind

/**
 * Pure native Android thin Remote Client UI (R5):
 *  - No embedded Node runtime, no local HTTP loop, no WebView hosting local DSH.
 *  - Pairs via PairingBootstrapDescriptor JSON or secret-free mDNS `_dsh-remote._tcp.`.
 *  - Lists official Host sessions, streams events, submits idempotent prompts, approvals, and questions.
 */
class MainActivity : AppCompatActivity(), RemoteSessionService.UiObserver {
    private var service: RemoteSessionService? = null
    private var bound = false
    private var mdnsDiscoverer: LanMdnsDiscoverer? = null

    private lateinit var statusView: TextView
    private lateinit var deviceIdView: TextView
    private lateinit var pairingInput: EditText
    private lateinit var sessionIdInput: EditText
    private lateinit var promptInput: EditText
    private lateinit var eventLogView: TextView
    private lateinit var approvalBanner: TextView
    private lateinit var answerInput: EditText

    private var pendingCallId: String? = null
    private var pendingQuestionId: String? = null
    private val discoveredHosts = LinkedHashMap<String, DiscoveredLanHost>()

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val local = (binder as RemoteSessionService.LocalBinder).getService()
            service = local
            bound = true
            local.addObserver(this@MainActivity)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            bound = false
            service = null
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        statusView = findViewById(R.id.tv_status)
        deviceIdView = findViewById(R.id.tv_device_id)
        pairingInput = findViewById(R.id.et_pairing_json)
        sessionIdInput = findViewById(R.id.et_session_id)
        promptInput = findViewById(R.id.et_prompt)
        eventLogView = findViewById(R.id.tv_events)
        approvalBanner = findViewById(R.id.tv_approval)
        answerInput = findViewById(R.id.et_answer)

        val startIntent = Intent(this, RemoteSessionService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(startIntent)
        } else {
            startService(startIntent)
        }

        findViewById<Button>(R.id.btn_connect).setOnClickListener {
            val raw = pairingInput.text.toString().trim()
            if (raw.isNotEmpty()) {
                service?.connectWithPairingJson(raw)
            }
        }

        findViewById<Button>(R.id.btn_scan_lan).setOnClickListener {
            startMdnsScan()
        }

        findViewById<Button>(R.id.btn_failover).setOnClickListener {
            service?.failoverAsync()
        }

        findViewById<Button>(R.id.btn_disconnect).setOnClickListener {
            service?.disconnect()
        }

        findViewById<Button>(R.id.btn_sessions).setOnClickListener {
            service?.refreshSessionsAsync()
        }

        findViewById<Button>(R.id.btn_attach).setOnClickListener {
            val sid = sessionIdInput.text.toString().trim()
            if (sid.isNotEmpty()) {
                service?.attachSessionAsync(sid)
            }
        }

        findViewById<Button>(R.id.btn_send_prompt).setOnClickListener {
            val sid = sessionIdInput.text.toString().trim()
            val prompt = promptInput.text.toString().trim()
            if (sid.isNotEmpty() && prompt.isNotEmpty()) {
                service?.submitPromptAsync(sid, prompt)
                promptInput.text.clear()
            }
        }

        findViewById<Button>(R.id.btn_approve).setOnClickListener {
            val cid = pendingCallId ?: return@setOnClickListener
            service?.respondApprovalAsync(cid, approved = true)
            pendingCallId = null
            approvalBanner.text = getString(R.string.no_pending_interaction)
        }

        findViewById<Button>(R.id.btn_reject).setOnClickListener {
            val cid = pendingCallId ?: return@setOnClickListener
            service?.respondApprovalAsync(cid, approved = false)
            pendingCallId = null
            approvalBanner.text = getString(R.string.no_pending_interaction)
        }

        findViewById<Button>(R.id.btn_answer_question).setOnClickListener {
            val qid = pendingQuestionId ?: return@setOnClickListener
            val ans = answerInput.text.toString().trim()
            if (ans.isNotEmpty()) {
                service?.respondQuestionAsync(qid, ans)
                pendingQuestionId = null
                answerInput.text.clear()
                approvalBanner.text = getString(R.string.no_pending_interaction)
            }
        }
    }

    override fun onStart() {
        super.onStart()
        bindService(Intent(this, RemoteSessionService::class.java), connection, Context.BIND_AUTO_CREATE)
    }

    override fun onStop() {
        mdnsDiscoverer?.stop()
        if (bound) {
            service?.removeObserver(this)
            unbindService(connection)
            bound = false
        }
        super.onStop()
    }

    override fun onStatusChanged(
        phase: RemoteConnectionPhase,
        carrier: TransportKind?,
        epoch: Int,
        deviceId: String,
        message: String,
    ) {
        runOnUiThread {
            statusView.text = "[$phase] carrier=${carrier?.wireName ?: "-"} epoch=$epoch — $message"
            deviceIdView.text = "Device ID (Keystore-wrapped): $deviceId"
        }
    }

    override fun onSessionsUpdated(sessions: List<SessionRef>) {
        runOnUiThread {
            val summary = sessions.joinToString("\n") { "${it.id} (${it.title ?: "untitled"})" }
            appendLog("Sessions:\n$summary")
            if (sessionIdInput.text.isNullOrBlank() && sessions.isNotEmpty()) {
                sessionIdInput.setText(sessions.first().id)
            }
        }
    }

    override fun onEventReceived(sessionId: String, event: OfficialSessionEvent) {
        runOnUiThread {
            appendLog("[#$sessionId seq=${event.seq}] ${event.type}: ${event.data?.stringify() ?: ""}")
        }
    }

    override fun onPendingApproval(callId: String, summary: String) {
        runOnUiThread {
            pendingCallId = callId
            approvalBanner.text = "APPROVAL REQUIRED ($callId): $summary"
        }
    }

    override fun onPendingQuestion(questionId: String, prompt: String) {
        runOnUiThread {
            pendingQuestionId = questionId
            approvalBanner.text = "QUESTION ($questionId): $prompt"
        }
    }

    private fun startMdnsScan() {
        val discoverer = LanMdnsDiscoverer(this)
        mdnsDiscoverer = discoverer
        appendLog("Scanning mDNS ${_DshMdnsServiceLabel}...")
        discoverer.start(
            object : LanMdnsDiscoverer.Listener {
                override fun onHostFound(host: DiscoveredLanHost) {
                    discoveredHosts[host.endpointUrl] = host
                    runOnUiThread {
                        appendLog("mDNS Host: ${host.hostDisplayLabel} -> ${host.endpointUrl} fp=${host.hostFingerprint ?: "?"}")
                    }
                }

                override fun onDiscoveryFailed(errorCode: Int, reason: String) {
                    runOnUiThread { appendLog("mDNS error $errorCode: $reason") }
                }
            },
        )
    }

    private fun appendLog(line: String) {
        val existing = eventLogView.text?.toString().orEmpty()
        val combined = if (existing.isEmpty()) line else "$existing\n$line"
        eventLogView.text = combined.takeLast(8000)
    }

    private companion object {
        const val _DshMdnsServiceLabel = "_dsh-remote._tcp."
    }
}
