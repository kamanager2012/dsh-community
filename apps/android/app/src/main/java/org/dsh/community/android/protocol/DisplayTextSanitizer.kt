package org.dsh.community.android.protocol

/**
 * Strips ANSI/terminal escape sequences, Unicode Bidi spoofing controls, lone UTF-16 surrogates,
 * and non-printable control characters before displaying Host-supplied text in native Android UI.
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

    fun sanitizeLoneSurrogates(raw: String?): String {
        if (raw.isNullOrEmpty()) return ""
        var needsFix = false
        var checkIdx = 0
        while (checkIdx < raw.length) {
            val cp = raw.codePointAt(checkIdx)
            if (cp in 0xD800..0xDFFF) {
                needsFix = true
                break
            }
            checkIdx += Character.charCount(cp)
        }
        if (!needsFix) return raw
        val out = StringBuilder(raw.length)
        var idx = 0
        while (idx < raw.length) {
            val cp = raw.codePointAt(idx)
            if (cp in 0xD800..0xDFFF) {
                out.append('\uFFFD')
                idx += 1
            } else {
                out.appendCodePoint(cp)
                idx += Character.charCount(cp)
            }
        }
        return out.toString()
    }

    fun sanitizeMultiline(raw: String?, maxCodePoints: Int = Int.MAX_VALUE): String {
        if (raw.isNullOrEmpty() || maxCodePoints <= 0) return ""
        val withoutAnsi = ANSI_ESCAPE_RE.replace(raw, "")
            .replace("\r\n", "\n")
            .replace('\r', '\n')
        val initialCapacity = minOf(withoutAnsi.length.toLong(), maxCodePoints.toLong() * 2L)
            .coerceAtLeast(0L)
            .toInt()
        val out = StringBuilder(initialCapacity)
        var idx = 0
        var emitted = 0
        while (idx < withoutAnsi.length && emitted < maxCodePoints) {
            val cp = withoutAnsi.codePointAt(idx)
            if (cp in 0xD800..0xDFFF) {
                out.append('\uFFFD')
                emitted += 1
                idx += 1
                continue
            }
            val charCount = Character.charCount(cp)
            val keep = when {
                isBidiControl(cp) -> false
                cp == '\n'.code || cp == '\t'.code -> true
                Character.isISOControl(cp) -> false
                else -> true
            }
            if (keep) {
                out.appendCodePoint(cp)
                emitted += 1
            }
            idx += charCount
        }
        return out.toString()
    }

    fun truncateByCodePoints(
        raw: String?,
        maxCodePoints: Int,
        ellipsis: String = "…",
    ): String {
        if (raw.isNullOrEmpty() || maxCodePoints <= 0) return ""
        val clean = sanitizeLoneSurrogates(raw)
        val total = clean.codePointCount(0, clean.length)
        if (total <= maxCodePoints) return clean
        val ellipsisCp = ellipsis.codePointCount(0, ellipsis.length)
        if (maxCodePoints <= ellipsisCp) {
            val idx = clean.offsetByCodePoints(0, maxCodePoints)
            return clean.substring(0, idx)
        }
        val keepCp = maxCodePoints - ellipsisCp
        val endIdx = clean.offsetByCodePoints(0, keepCp)
        return clean.substring(0, endIdx) + ellipsis
    }

    fun sanitizeSingleLine(raw: String?, maxCodePoints: Int = Int.MAX_VALUE): String {
        val multi = sanitizeMultiline(raw, maxCodePoints)
        if (multi.isEmpty()) return ""
        val out = StringBuilder(multi.length)
        var idx = 0
        while (idx < multi.length) {
            val cp = multi.codePointAt(idx)
            val step = Character.charCount(cp)
            if (cp == '\n'.code || cp == '\t'.code) {
                out.append(' ')
            } else {
                out.appendCodePoint(cp)
            }
            idx += step
        }
        return out.toString().trim()
    }
}
