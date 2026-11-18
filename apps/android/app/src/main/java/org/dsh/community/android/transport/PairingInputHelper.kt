package org.dsh.community.android.transport

import java.net.URI

/**
 * Pure Kotlin helpers for extracting validated pairing inputs from intents/clipboards,
 * resolving loopback pairing hints, and keeping foreground notification status text accurate.
 */
object PairingInputHelper {
    const val ACTION_VIEW_NAME = "android.intent.action.VIEW"
    const val ACTION_SEND_NAME = "android.intent.action.SEND"

    private const val LOOPBACK_FAILURE_HINT =
        " (Hint: endpoint uses 127.0.0.1/localhost; on a physical phone use the Host LAN IP or USB adb reverse)"

    private val DEEP_LINK_REGEX = Regex("""dsh-remote://pair\?[^\s"'<>]+""", RegexOption.IGNORE_CASE)

    /**
     * Returns true when [url] points at a loopback host (`127.0.0.1`, `localhost`, `::1`, `[::1]`),
     * which on a physical Android phone refers to the phone itself rather than the workstation Host.
     */
    fun isLoopbackEndpoint(url: String?): Boolean {
        val trimmed = url?.trim()?.takeIf { it.isNotEmpty() } ?: return false
        val parsedHost = runCatching {
            val uri = if (trimmed.contains("://")) URI(trimmed) else URI("ws://$trimmed")
            uri.host?.lowercase()?.trim('[', ']')
        }.getOrNull()
        return parsedHost == "127.0.0.1" || parsedHost == "localhost" || parsedHost == "::1"
    }

    /**
     * Appends an actionable physical-device hint when connecting to a loopback LAN URL fails.
     */
    fun appendLoopbackFailureHint(rawError: String, lanUrl: String?): String {
        if (!isLoopbackEndpoint(lanUrl)) return rawError
        if (rawError.contains("Hint: endpoint uses 127.0.0.1/localhost", ignoreCase = true)) {
            return rawError
        }
        return rawError + LOOPBACK_FAILURE_HINT
    }

    /**
     * When a pairing descriptor specifies a loopback URL and a non-loopback [discoveredLanUrl] is
     * known from live LAN discovery, substitutes the reachable LAN URL.
     */
    fun resolvePairingEndpointWithDiscovery(
        descriptor: PairingBootstrapDescriptor,
        discoveredLanUrl: String?,
    ): PairingBootstrapDescriptor {
        val candidate = discoveredLanUrl?.trim()?.takeIf { it.isNotEmpty() } ?: return descriptor
        if (!isLoopbackEndpoint(descriptor.endpointUrl) || isLoopbackEndpoint(candidate)) {
            return descriptor
        }
        return descriptor.copy(endpointUrl = candidate)
    }

    /**
     * Builds a fallback LAN URL for an unreachable loopback pairing endpoint using the host from a
     * saved [savedLanUrl] while preserving the fresh QR descriptor's ephemeral port and scheme.
     */
    fun buildSavedLanFallbackUrl(freshEndpointUrl: String?, savedLanUrl: String?): String? {
        if (!isLoopbackEndpoint(freshEndpointUrl)) return null
        val trimmedFresh = freshEndpointUrl?.trim() ?: return null
        val trimmedSaved = savedLanUrl?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        if (isLoopbackEndpoint(trimmedSaved)) return null

        return runCatching {
            val freshUri = URI(if (trimmedFresh.contains("://")) trimmedFresh else "ws://$trimmedFresh")
            val savedUri = URI(if (trimmedSaved.contains("://")) trimmedSaved else "ws://$trimmedSaved")
            val rawHost = savedUri.host?.takeIf { it.isNotBlank() } ?: return null
            val host = if (rawHost.contains(':') && !rawHost.startsWith("[")) "[$rawHost]" else rawHost
            val port = if (freshUri.port > 0) freshUri.port else savedUri.port
            val scheme = freshUri.scheme ?: savedUri.scheme ?: "ws"
            URI(
                scheme,
                null,
                host,
                port,
                freshUri.path?.takeIf { it.isNotEmpty() },
                freshUri.query?.takeIf { it.isNotEmpty() },
                null,
            ).toString()
        }.getOrNull()
    }

    /**
     * Extracts either an embedded `dsh-remote://pair?...` URI or a trimmed JSON descriptor
     * object from clipboard or shared text. Returns null if no pairing payload is present.
     */
    fun extractPairingPayload(rawText: String?): String? {
        val trimmed = rawText?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val match = DEEP_LINK_REGEX.find(trimmed)
        if (match != null) {
            return match.value.trimEnd('.', ',', ';', ')', ']')
        }
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            return trimmed
        }
        return null
    }

    /**
     * Extracts a pairing input from either a `VIEW` (`dsh-remote://pair?...`) intent
     * or a `SEND` (`text/plain`) share intent containing a deep link or JSON descriptor.
     */
    fun extractFromIntent(action: String?, dataString: String?, extraText: String?): String? {
        return when (action) {
            ACTION_VIEW_NAME -> {
                val uri = dataString?.trim()?.takeIf { it.isNotEmpty() } ?: return null
                if (uri.startsWith("dsh-remote://", ignoreCase = true)) uri else null
            }
            ACTION_SEND_NAME -> extractPairingPayload(extraText)
            else -> null
        }
    }

    /**
     * Preserves active session carrier/epoch text when MainActivity restarts/rebinds
     * RemoteSessionService, falling back to Idle count only when no session is active.
     */
    fun resolveForegroundNotificationText(
        hasActiveSession: Boolean,
        currentStatus: String,
        startCount: Int,
    ): String {
        val cleaned = currentStatus.trim()
        if (hasActiveSession && cleaned.isNotEmpty()) {
            return cleaned
        }
        return "Idle ($startCount starts)"
    }
}
