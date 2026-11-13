package org.dsh.community.android.transport

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import java.net.Inet4Address
import java.nio.charset.StandardCharsets
import java.util.ArrayDeque

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
        get() = LanMdnsSanitizer.formatEndpointUrl(hostAddress, port)
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

    fun formatEndpointUrl(hostAddress: String, port: Int): String {
        val clean = hostAddress.trim().substringBefore('%')
        return if (clean.contains(':')) {
            "ws://[$clean]:$port"
        } else {
            "ws://$clean:$port"
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
        val version = (txt["protocolVersion"] ?: txt["v"])?.trim()?.toIntOrNull() ?: 1
        val fingerprint = (txt["hostFingerprint"] ?: txt["fingerprint"] ?: txt["fp"])
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
        val displayLabel = (txt["hostDisplayLabel"] ?: txt["label"])
            ?.trim()
            ?.takeIf { it.isNotEmpty() }
            ?: serviceName
        return DiscoveredLanHost(
            serviceName = serviceName,
            hostAddress = hostAddress,
            port = port,
            hostFingerprint = fingerprint,
            hostDisplayLabel = displayLabel,
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
    private val resolveLock = Any()
    private val resolveQueue = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private var stopped = true

    fun start(listener: Listener) {
        stop()
        synchronized(resolveLock) {
            stopped = false
            resolving = false
            resolveQueue.clear()
        }
        val activeListener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(regType: String) = Unit

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                enqueueResolve(serviceInfo, listener)
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) = Unit

            override fun onDiscoveryStopped(serviceType: String) {
                if (discoveryListener === this) {
                    discoveryListener = null
                }
            }

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                if (discoveryListener === this) {
                    discoveryListener = null
                }
                listener.onDiscoveryFailed(errorCode, "start discovery failed ($errorCode)")
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                if (discoveryListener === this) {
                    discoveryListener = null
                }
            }
        }
        discoveryListener = activeListener
        nsdManager.discoverServices(
            LanMdnsSanitizer.SERVICE_TYPE,
            NsdManager.PROTOCOL_DNS_SD,
            activeListener,
        )
    }

    fun stop() {
        synchronized(resolveLock) {
            stopped = true
            resolving = false
            resolveQueue.clear()
        }
        val current = discoveryListener ?: return
        discoveryListener = null
        try {
            nsdManager.stopServiceDiscovery(current)
        } catch (_: IllegalArgumentException) {
            // Already stopped
        }
    }

    private fun enqueueResolve(serviceInfo: NsdServiceInfo, listener: Listener) {
        val next = synchronized(resolveLock) {
            if (stopped) return
            resolveQueue.addLast(serviceInfo)
            if (resolving) return
            resolving = true
            resolveQueue.removeFirst()
        }
        dispatchResolve(next, listener)
    }

    private fun dispatchResolve(target: NsdServiceInfo, listener: Listener) {
        try {
            @Suppress("DEPRECATION")
            nsdManager.resolveService(
                target,
                object : NsdManager.ResolveListener {
                    override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
                        advanceResolveQueue(listener)
                    }

                    override fun onServiceResolved(resolved: NsdServiceInfo) {
                        try {
                            val hostAddr = selectHostAddress(resolved)
                            if (hostAddr != null) {
                                val host = LanMdnsSanitizer.toDiscoveredHost(
                                    serviceName = resolved.serviceName,
                                    hostAddress = hostAddr,
                                    port = resolved.port,
                                    rawAttributes = resolved.attributes,
                                )
                                listener.onHostFound(host)
                            }
                        } catch (_: SecurityException) {
                            // Drop untrusted mDNS packet attempting secret injection
                        } finally {
                            advanceResolveQueue(listener)
                        }
                    }
                },
            )
        } catch (_: IllegalArgumentException) {
            advanceResolveQueue(listener)
        }
    }

    private fun advanceResolveQueue(listener: Listener) {
        val next = synchronized(resolveLock) {
            if (stopped || resolveQueue.isEmpty()) {
                resolving = false
                return
            }
            resolveQueue.removeFirst()
        }
        dispatchResolve(next, listener)
    }

    private fun selectHostAddress(resolved: NsdServiceInfo): String? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val addrs = resolved.hostAddresses
            val preferred = addrs.firstOrNull { it is Inet4Address } ?: addrs.firstOrNull()
            if (preferred?.hostAddress != null) {
                return preferred.hostAddress
            }
        }
        @Suppress("DEPRECATION")
        return resolved.host?.hostAddress
    }
}
