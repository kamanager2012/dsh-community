package org.dsh.community.android.transport

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import java.nio.charset.StandardCharsets

data class DiscoveredLanHost(
    val serviceName: String,
    val hostAddress: String,
    val port: Int,
    val hostFingerprint: String?,
    val hostDisplayLabel: String,
    val protocolVersion: Int,
    val txtAttributes: Map<String, String>,
) {
    val endpointUrl: String
        get() = "ws://$hostAddress:$port"
}

/**
 * Secret-free LAN discovery over `_dsh-remote._tcp.` matching `packages/remote-adapter/src/carrier/mdns.ts`.
 * Explicitly rejects any mDNS TXT record containing bootstrap tokens, session IDs, or credential keys.
 */
object LanMdnsSanitizer {
    const val SERVICE_TYPE = "_dsh-remote._tcp."

    private val FORBIDDEN_SECRET_KEYS = listOf(
        "token",
        "pairingtoken",
        "bootstraptoken",
        "sessionid",
        "session",
        "prompt",
        "secret",
        "secretkey",
        "privatekey",
        "privkey",
        "credential",
        "credentials",
        "password",
        "apikey",
        "auth",
        "authorization",
    )

    fun assertNoSecrets(txt: Map<String, String>) {
        for (key in txt.keys) {
            val lower = key.lowercase()
            for (forbidden in FORBIDDEN_SECRET_KEYS) {
                if (lower == forbidden || lower.contains(forbidden)) {
                    throw SecurityException(
                        "mDNS TXT record contains forbidden secret/credential key: '$key'",
                    )
                }
            }
        }
    }

    fun toDiscoveredHost(
        serviceName: String,
        hostAddress: String,
        port: Int,
        rawAttributes: Map<String, ByteArray?>,
    ): DiscoveredLanHost {
        val txt = LinkedHashMap<String, String>()
        for ((k, v) in rawAttributes) {
            txt[k] = if (v == null) "" else String(v, StandardCharsets.UTF_8)
        }
        assertNoSecrets(txt)
        val version = txt["protocolVersion"]?.toIntOrNull() ?: 1
        return DiscoveredLanHost(
            serviceName = serviceName,
            hostAddress = hostAddress,
            port = port,
            hostFingerprint = txt["hostFingerprint"] ?: txt["fingerprint"],
            hostDisplayLabel = txt["hostDisplayLabel"] ?: serviceName,
            protocolVersion = version,
            txtAttributes = txt,
        )
    }
}

class LanMdnsDiscoverer(context: Context) {
    interface Listener {
        fun onHostFound(host: DiscoveredLanHost)
        fun onDiscoveryFailed(errorCode: Int, reason: String)
    }

    private val nsdManager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private var discoveryListener: NsdManager.DiscoveryListener? = null

    fun start(listener: Listener) {
        stop()
        val activeListener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(regType: String) = Unit

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                @Suppress("DEPRECATION")
                nsdManager.resolveService(
                    serviceInfo,
                    object : NsdManager.ResolveListener {
                        override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) = Unit

                        override fun onServiceResolved(resolved: NsdServiceInfo) {
                            try {
                                @Suppress("DEPRECATION")
                                val hostAddr = resolved.host?.hostAddress ?: return
                                val host = LanMdnsSanitizer.toDiscoveredHost(
                                    serviceName = resolved.serviceName,
                                    hostAddress = hostAddr,
                                    port = resolved.port,
                                    rawAttributes = resolved.attributes,
                                )
                                listener.onHostFound(host)
                            } catch (_: SecurityException) {
                                // Drop untrusted mDNS packet attempting secret injection
                            }
                        }
                    },
                )
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) = Unit
            override fun onDiscoveryStopped(serviceType: String) = Unit

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                listener.onDiscoveryFailed(errorCode, "start discovery failed ($errorCode)")
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
        }
        discoveryListener = activeListener
        nsdManager.discoverServices(
            LanMdnsSanitizer.SERVICE_TYPE,
            NsdManager.PROTOCOL_DNS_SD,
            activeListener,
        )
    }

    fun stop() {
        val current = discoveryListener ?: return
        discoveryListener = null
        try {
            nsdManager.stopServiceDiscovery(current)
        } catch (_: IllegalArgumentException) {
            // Already stopped
        }
    }
}
