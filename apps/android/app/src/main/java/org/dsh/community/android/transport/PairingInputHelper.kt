package org.dsh.community.android.transport

/**
 * Pure Kotlin helpers for extracting validated pairing inputs from intents/clipboards
 * and keeping foreground notification status text accurate across service starts.
 */
object PairingInputHelper {
    const val ACTION_VIEW_NAME = "android.intent.action.VIEW"
    const val ACTION_SEND_NAME = "android.intent.action.SEND"

    private val DEEP_LINK_REGEX = Regex("""dsh-remote://pair\?[^\s"'<>]+""", RegexOption.IGNORE_CASE)

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
