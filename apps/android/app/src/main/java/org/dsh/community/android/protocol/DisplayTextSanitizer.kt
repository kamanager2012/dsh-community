package org.dsh.community.android.protocol

/**
 * Strips ANSI/terminal escape sequences, Unicode Bidi spoofing controls, and non-printable
 * control characters before displaying Host-supplied text in native Android UI components.
 */
object DisplayTextSanitizer {
    private val ANSI_ESCAPE_RE = Regex(
        """\u001B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])""",
    )

    private fun isBidiControl(code: Int): Boolean =
        code in 0x202A..0x202E ||
            code in 0x2066..0x2069 ||
            code == 0x200E ||
            code == 0x200F ||
            code == 0x061C

    fun sanitizeMultiline(raw: String?): String {
        if (raw.isNullOrEmpty()) return ""
        val withoutAnsi = ANSI_ESCAPE_RE.replace(raw, "")
            .replace("\r\n", "\n")
            .replace('\r', '\n')
        val out = StringBuilder(withoutAnsi.length)
        var idx = 0
        while (idx < withoutAnsi.length) {
            val cp = withoutAnsi.codePointAt(idx)
            val charCount = Character.charCount(cp)
            val keep = when {
                isBidiControl(cp) -> false
                cp == '\n'.code || cp == '\t'.code -> true
                Character.isISOControl(cp) -> false
                else -> true
            }
            if (keep) {
                out.appendCodePoint(cp)
            }
            idx += charCount
        }
        return out.toString()
    }

    fun sanitizeSingleLine(raw: String?): String {
        val multi = sanitizeMultiline(raw)
        if (multi.isEmpty()) return ""
        val out = StringBuilder(multi.length)
        for (ch in multi) {
            out.append(if (ch == '\n' || ch == '\t') ' ' else ch)
        }
        return out.toString().trim()
    }
}
