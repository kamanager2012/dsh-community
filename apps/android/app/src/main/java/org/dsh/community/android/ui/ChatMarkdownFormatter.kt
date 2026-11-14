package org.dsh.community.android.ui

import android.graphics.Typeface
import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.text.style.URLSpan

sealed interface MarkdownBlock {
    data class CodeFence(val language: String, val code: String) : MarkdownBlock
    data class ParagraphLines(val lines: List<String>) : MarkdownBlock
}

sealed interface MarkdownRenderBlock {
    data class Prose(val lines: List<String>) : MarkdownRenderBlock
    data class CodeFence(
        val language: String,
        val code: String,
        val isClosed: Boolean = true,
    ) : MarkdownRenderBlock

    data class Table(
        val headers: List<String>,
        val rows: List<List<String>>,
    ) : MarkdownRenderBlock

    data object HorizontalRule : MarkdownRenderBlock
}

sealed interface InlineSpanToken {
    data class Plain(val text: String) : InlineSpanToken
    data class Bold(val text: String) : InlineSpanToken
    data class Italic(val text: String) : InlineSpanToken
    data class BoldItalic(val text: String) : InlineSpanToken
    data class Code(val text: String) : InlineSpanToken
    data class Strike(val text: String) : InlineSpanToken
    data class Link(val label: String, val url: String) : InlineSpanToken
}

/**
 * Pure Kotlin lightweight Markdown parser & Spannable formatter optimized for technical coding
 * responses: headings, task lists, nested lists, blockquotes, GFM tables, inline styles, and
 * syntax-highlighted fenced code blocks without third-party dependencies or WebView.
 */
object ChatMarkdownFormatter {
    private const val COLOR_CODE_BG = 0xFF0B0E14.toInt()
    private const val COLOR_INLINE_CODE_BG = 0xFF21262D.toInt()
    private const val COLOR_CODE_FG = 0xFF79C0FF.toInt()
    private const val COLOR_HEADING = 0xFFF0F6FC.toInt()
    private const val COLOR_MUTED = 0xFF8B949E.toInt()
    private const val COLOR_BOLD = 0xFFFFFFFF.toInt()
    private const val COLOR_QUOTE = 0xFFA5D6FF.toInt()
    private const val COLOR_LINK = 0xFF58A6FF.toInt()
    private const val COLOR_CHECK_DONE = 0xFF2EA043.toInt()
    private const val COLOR_TABLE_RULE = 0xFF30363D.toInt()

    fun extractFirstCodeBlock(markdown: String): String? =
        extractAllCodeBlocks(markdown).firstOrNull()?.second

    fun extractAllCodeBlocks(markdown: String): List<Pair<String, String>> =
        parseRenderBlocks(markdown)
            .filterIsInstance<MarkdownRenderBlock.CodeFence>()
            .mapNotNull { fence ->
                val code = fence.code.trimEnd()
                if (code.isBlank()) null else fence.language to code
            }

    fun isHorizontalRule(line: String): Boolean {
        val compact = line.trim().replace(" ", "")
        return compact.length >= 3 && compact.all { it == '-' || it == '*' || it == '_' } &&
            compact.toSet().size == 1
    }

    fun parseOrderedListPrefix(trimmedLine: String): Pair<String, String>? {
        val dotIdx = trimmedLine.indexOf('.')
        if (dotIdx !in 1..4) return null
        val digits = trimmedLine.substring(0, dotIdx)
        if (!digits.all { it.isDigit() }) return null
        if (dotIdx + 1 >= trimmedLine.length || trimmedLine[dotIdx + 1] != ' ') return null
        val rest = trimmedLine.substring(dotIdx + 2)
        return "$digits." to rest
    }

    private data class TaskListPrefix(
        val checked: Boolean,
        val rest: String,
    )

    private fun parseTaskListPrefix(trimmedLine: String): TaskListPrefix? {
        if (trimmedLine.length < 6) return null
        val bullet = trimmedLine[0]
        if (bullet != '-' && bullet != '*' && bullet != '+') return null
        if (trimmedLine[1] != ' ' || trimmedLine[2] != '[' || trimmedLine[4] != ']' || trimmedLine[5] != ' ') {
            return null
        }
        val state = trimmedLine[3]
        if (state != ' ' && state != 'x' && state != 'X') return null
        return TaskListPrefix(checked = state == 'x' || state == 'X', rest = trimmedLine.substring(6))
    }

    private fun isSafeWebUrl(url: String): Boolean {
        val lower = url.trim().lowercase()
        return lower.startsWith("https://") || lower.startsWith("http://")
    }

    fun tokenizeInline(text: String): List<InlineSpanToken> {
        val tokens = ArrayList<InlineSpanToken>()
        val plain = StringBuilder()

        fun flushPlain() {
            if (plain.isNotEmpty()) {
                tokens.add(InlineSpanToken.Plain(plain.toString()))
                plain.setLength(0)
            }
        }

        var i = 0
        while (i < text.length) {
            if (text[i] == '`') {
                val end = text.indexOf('`', i + 1)
                if (end > i + 1) {
                    flushPlain()
                    tokens.add(InlineSpanToken.Code(text.substring(i + 1, end)))
                    i = end + 1
                    continue
                }
            }
            if (text.startsWith("***", i)) {
                val end = text.indexOf("***", i + 3)
                if (end > i + 3) {
                    flushPlain()
                    tokens.add(InlineSpanToken.BoldItalic(text.substring(i + 3, end)))
                    i = end + 3
                    continue
                }
            }
            if (text.startsWith("**", i)) {
                val end = text.indexOf("**", i + 2)
                if (end > i + 2) {
                    flushPlain()
                    tokens.add(InlineSpanToken.Bold(text.substring(i + 2, end)))
                    i = end + 2
                    continue
                }
            }
            if (text.startsWith("__", i) && isWordBoundaryBefore(text, i)) {
                val end = text.indexOf("__", i + 2)
                if (end > i + 2 && isWordBoundaryAfter(text, end + 2)) {
                    flushPlain()
                    tokens.add(InlineSpanToken.Bold(text.substring(i + 2, end)))
                    i = end + 2
                    continue
                }
            }
            if (text.startsWith("~~", i)) {
                val end = text.indexOf("~~", i + 2)
                if (end > i + 2) {
                    flushPlain()
                    tokens.add(InlineSpanToken.Strike(text.substring(i + 2, end)))
                    i = end + 2
                    continue
                }
            }
            if (text[i] == '[') {
                val closeBracket = text.indexOf(']', i + 1)
                if (closeBracket > i + 1 && closeBracket + 1 < text.length && text[closeBracket + 1] == '(') {
                    val closeParen = text.indexOf(')', closeBracket + 2)
                    if (closeParen > closeBracket + 2) {
                        val label = text.substring(i + 1, closeBracket)
                        val url = text.substring(closeBracket + 2, closeParen).trim()
                        if (isSafeWebUrl(url)) {
                            flushPlain()
                            tokens.add(InlineSpanToken.Link(label = label, url = url))
                            i = closeParen + 1
                            continue
                        }
                    }
                }
            }
            if (text[i] == '*' && !text.startsWith("**", i) && i + 1 < text.length && !text[i + 1].isWhitespace()) {
                val end = findClosingSingleAsterisk(text, i + 1)
                if (end > i + 1) {
                    flushPlain()
                    tokens.add(InlineSpanToken.Italic(text.substring(i + 1, end)))
                    i = end + 1
                    continue
                }
            }
            if (text[i] == '_' && !text.startsWith("__", i) && isWordBoundaryBefore(text, i)) {
                val end = findClosingSingleUnderscore(text, i + 1)
                if (end > i + 1 && isWordBoundaryAfter(text, end + 1)) {
                    flushPlain()
                    tokens.add(InlineSpanToken.Italic(text.substring(i + 1, end)))
                    i = end + 1
                    continue
                }
            }
            plain.append(text[i])
            i++
        }
        flushPlain()
        return tokens
    }

    private fun isWordBoundaryBefore(text: String, idx: Int): Boolean {
        if (idx <= 0) return true
        val prev = text[idx - 1]
        return !prev.isLetterOrDigit()
    }

    private fun isWordBoundaryAfter(text: String, idxAfterToken: Int): Boolean {
        if (idxAfterToken >= text.length) return true
        val next = text[idxAfterToken]
        return !next.isLetterOrDigit()
    }

    private fun findClosingSingleAsterisk(text: String, start: Int): Int {
        var i = start
        while (i < text.length) {
            if (text[i] == '\n') return -1
            if (text[i] == '*' && text[i - 1] != '\\') {
                if (i + 1 < text.length && text[i + 1] == '*') {
                    i += 2
                    continue
                }
                if (!text[i - 1].isWhitespace()) {
                    return i
                }
            }
            i++
        }
        return -1
    }

    private fun findClosingSingleUnderscore(text: String, start: Int): Int {
        var i = start
        while (i < text.length) {
            if (text[i] == '\n') return -1
            if (text[i] == '_' && text[i - 1] != '\\') {
                if (i + 1 < text.length && text[i + 1] == '_') {
                    i += 2
                    continue
                }
                if (isWordBoundaryAfter(text, i + 1) && text[i - 1] != ' ') {
                    return i
                }
            }
            i++
        }
        return -1
    }

    fun parseBlocks(markdown: String): List<MarkdownBlock> {
        val blocks = ArrayList<MarkdownBlock>()
        val paraBuf = ArrayList<String>()

        fun flushPara() {
            if (paraBuf.isNotEmpty()) {
                blocks.add(MarkdownBlock.ParagraphLines(paraBuf.toList()))
                paraBuf.clear()
            }
        }

        for (block in parseRenderBlocks(markdown)) {
            when (block) {
                is MarkdownRenderBlock.CodeFence -> {
                    flushPara()
                    blocks.add(MarkdownBlock.CodeFence(block.language, block.code))
                }
                is MarkdownRenderBlock.Prose -> paraBuf.addAll(block.lines)
                is MarkdownRenderBlock.Table -> {
                    paraBuf.addAll(formatTableMarkdownLines(block))
                }
                MarkdownRenderBlock.HorizontalRule -> paraBuf.add("---")
            }
        }
        flushPara()
        return blocks
    }

    fun parseRenderBlocks(markdown: String): List<MarkdownRenderBlock> {
        if (markdown.isEmpty()) return emptyList()
        val lines = markdown.replace("\r\n", "\n").replace('\r', '\n').split('\n')
        val blocks = ArrayList<MarkdownRenderBlock>()
        var inCode = false
        var fenceChar = '`'
        var fenceLen = 3
        var codeLang = ""
        val codeBuf = ArrayList<String>()
        val paraBuf = ArrayList<String>()

        fun flushPara() {
            while (paraBuf.isNotEmpty() && paraBuf.first().isBlank()) paraBuf.removeAt(0)
            while (paraBuf.isNotEmpty() && paraBuf.last().isBlank()) paraBuf.removeAt(paraBuf.lastIndex)
            if (paraBuf.isNotEmpty()) {
                blocks.add(MarkdownRenderBlock.Prose(paraBuf.toList()))
                paraBuf.clear()
            }
        }

        fun flushCode(closed: Boolean) {
            blocks.add(MarkdownRenderBlock.CodeFence(codeLang, codeBuf.joinToString("\n"), isClosed = closed))
            codeBuf.clear()
            codeLang = ""
        }

        var idx = 0
        while (idx < lines.size) {
            val line = lines[idx]
            val trimmed = line.trimStart()
            if (!inCode) {
                val fence = matchOpeningFence(trimmed)
                if (fence != null) {
                    flushPara()
                    inCode = true
                    fenceChar = fence.first
                    fenceLen = fence.second
                    codeLang = fence.third
                    idx++
                    continue
                }

                // GFM Table check: header line containing `|` followed by delimiter row
                if (idx + 1 < lines.size && looksLikeTableRow(line) && isTableDelimiterRow(lines[idx + 1])) {
                    val headers = splitTableRow(line)
                    val colCount = headers.size
                    val delimiterCols = splitTableRow(lines[idx + 1]).size
                    if (colCount > 0 && delimiterCols == colCount) {
                        flushPara()
                        val rows = ArrayList<List<String>>()
                        var r = idx + 2
                        while (r < lines.size && looksLikeTableRow(lines[r]) && !isTableDelimiterRow(lines[r])) {
                            val rawCells = splitTableRow(lines[r])
                            val normalized = List(colCount) { col -> rawCells.getOrElse(col) { "" } }
                            rows.add(normalized)
                            r++
                        }
                        blocks.add(MarkdownRenderBlock.Table(headers = headers, rows = rows))
                        idx = r
                        continue
                    }
                }

                if (isHorizontalRule(line)) {
                    flushPara()
                    blocks.add(MarkdownRenderBlock.HorizontalRule)
                    idx++
                    continue
                }

                paraBuf.add(line)
            } else {
                if (isClosingFence(trimmed, fenceChar, fenceLen)) {
                    flushCode(closed = true)
                    inCode = false
                } else {
                    codeBuf.add(line)
                }
            }
            idx++
        }
        if (inCode) {
            flushCode(closed = false)
        }
        flushPara()
        return blocks
    }

    private fun matchOpeningFence(trimmed: String): Triple<Char, Int, String>? {
        if (trimmed.length < 3) return null
        val ch = trimmed[0]
        if (ch != '`' && ch != '~') return null
        var count = 0
        while (count < trimmed.length && trimmed[count] == ch) count++
        if (count < 3) return null
        val info = trimmed.substring(count).trim()
        if (ch == '`' && info.contains('`')) return null
        val langToken = info.split(' ', '\t').firstOrNull().orEmpty()
        return Triple(ch, count, CodeSyntaxHighlighter.normalizeLanguage(langToken))
    }

    private fun isClosingFence(trimmed: String, expectedChar: Char, minLen: Int): Boolean {
        var count = 0
        while (count < trimmed.length && trimmed[count] == expectedChar) count++
        if (count < minLen) return false
        return trimmed.substring(count).isBlank()
    }

    private fun looksLikeTableRow(line: String): Boolean {
        val t = line.trim()
        return t.contains('|') && t.isNotEmpty()
    }

    private fun isTableDelimiterRow(line: String): Boolean {
        val cells = splitTableRow(line)
        if (cells.isEmpty()) return false
        return cells.all { cell ->
            val t = cell.trim()
            if (t.isEmpty()) return@all false
            var dashes = 0
            for (c in t) {
                when (c) {
                    '-' -> dashes++
                    ':' -> {}
                    else -> return@all false
                }
            }
            dashes >= 1
        }
    }

    private fun splitTableRow(line: String): List<String> {
        var s = line.trim()
        if (s.startsWith("|")) s = s.substring(1)
        if (s.endsWith("|") && (s.length < 2 || s[s.length - 2] != '\\')) {
            s = s.substring(0, s.length - 1)
        }
        val cells = ArrayList<String>()
        val cur = StringBuilder()
        var i = 0
        while (i < s.length) {
            if (s[i] == '\\' && i + 1 < s.length && s[i + 1] == '|') {
                cur.append('|')
                i += 2
                continue
            }
            if (s[i] == '|') {
                cells.add(cur.toString().trim())
                cur.setLength(0)
            } else {
                cur.append(s[i])
            }
            i++
        }
        cells.add(cur.toString().trim())
        return cells
    }

    private fun formatTableMarkdownLines(table: MarkdownRenderBlock.Table): List<String> {
        val lines = ArrayList<String>(table.rows.size + 2)
        lines.add("| ${table.headers.joinToString(" | ")} |")
        lines.add("| ${table.headers.joinToString(" | ") { "---" }} |")
        for (row in table.rows) {
            lines.add("| ${row.joinToString(" | ")} |")
        }
        return lines
    }

    fun formatTableText(table: MarkdownRenderBlock.Table): CharSequence {
        val colCount = table.headers.size
        if (colCount == 0) return ""
        val widths = IntArray(colCount) { col -> table.headers[col].length }
        for (row in table.rows) {
            for (col in 0 until colCount) {
                val len = row.getOrElse(col) { "" }.length
                if (len > widths[col]) widths[col] = len
            }
        }
        for (c in widths.indices) {
            widths[c] = widths[c].coerceIn(3, 36)
        }

        val out = SpannableStringBuilder()
        fun appendRow(cells: List<String>, isHeader: Boolean) {
            val rowStart = out.length
            for (col in 0 until colCount) {
                if (col > 0) {
                    val sepStart = out.length
                    out.append(" │ ")
                    out.setSpan(ForegroundColorSpan(COLOR_TABLE_RULE), sepStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                val cell = cells.getOrElse(col) { "" }
                val padded = cell.padEnd(widths[col])
                if (isHeader) {
                    out.append(padded)
                } else {
                    appendInline(out, cell)
                    val deficit = widths[col] - visibleInlineLength(cell)
                    if (deficit > 0) out.append(" ".repeat(deficit))
                }
            }
            if (isHeader) {
                out.setSpan(StyleSpan(Typeface.BOLD), rowStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                out.setSpan(ForegroundColorSpan(COLOR_HEADING), rowStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        }

        appendRow(table.headers, isHeader = true)
        out.append('\n')
        val sepLineStart = out.length
        for (col in 0 until colCount) {
            if (col > 0) out.append("─┼─")
            out.append("─".repeat(widths[col]))
        }
        out.setSpan(ForegroundColorSpan(COLOR_TABLE_RULE), sepLineStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)

        for (row in table.rows) {
            out.append('\n')
            appendRow(row, isHeader = false)
        }
        return out
    }

    private fun visibleInlineLength(text: String): Int {
        var total = 0
        for (tok in tokenizeInline(text)) {
            total += when (tok) {
                is InlineSpanToken.Plain -> tok.text.length
                is InlineSpanToken.Bold -> tok.text.length
                is InlineSpanToken.Italic -> tok.text.length
                is InlineSpanToken.BoldItalic -> tok.text.length
                is InlineSpanToken.Code -> tok.text.length + 2
                is InlineSpanToken.Strike -> tok.text.length
                is InlineSpanToken.Link -> tok.label.length
            }
        }
        return total
    }

    fun format(markdown: String): CharSequence {
        if (markdown.isBlank()) return ""
        val blocks = parseRenderBlocks(markdown)
        val out = SpannableStringBuilder()
        blocks.forEachIndexed { idx, block ->
            if (idx > 0 && out.isNotEmpty() && out.last() != '\n') {
                out.append("\n\n")
            }
            when (block) {
                is MarkdownRenderBlock.CodeFence -> appendCodeFence(out, block.language, block.code)
                is MarkdownRenderBlock.Prose -> appendParagraphLines(out, block.lines)
                is MarkdownRenderBlock.Table -> out.append(formatTableText(block))
                MarkdownRenderBlock.HorizontalRule -> {
                    val hrStart = out.length
                    out.append("────────────")
                    out.setSpan(ForegroundColorSpan(COLOR_MUTED), hrStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
            }
        }
        return out
    }

    fun formatProseLines(lines: List<String>): CharSequence {
        if (lines.isEmpty()) return ""
        val out = SpannableStringBuilder()
        appendParagraphLines(out, lines)
        return out
    }

    fun formatThinking(thinkingText: String): CharSequence {
        if (thinkingText.isBlank()) return ""
        val blocks = parseRenderBlocks(thinkingText)
        val out = SpannableStringBuilder()
        blocks.forEachIndexed { idx, block ->
            if (idx > 0 && out.isNotEmpty() && out.last() != '\n') {
                out.append("\n\n")
            }
            when (block) {
                is MarkdownRenderBlock.CodeFence -> {
                    val codeStart = out.length
                    out.append(CodeSyntaxHighlighter.highlight(block.code, block.language))
                    out.setSpan(TypefaceSpan("monospace"), codeStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                is MarkdownRenderBlock.Prose -> appendParagraphLines(out, block.lines)
                is MarkdownRenderBlock.Table -> out.append(formatTableText(block))
                MarkdownRenderBlock.HorizontalRule -> out.append("────────────")
            }
        }
        return out
    }

    private fun appendCodeFence(out: SpannableStringBuilder, lang: String, code: String) {
        if (lang.isNotEmpty()) {
            val headerStart = out.length
            out.append("[$lang]\n")
            out.setSpan(ForegroundColorSpan(COLOR_MUTED), headerStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
            out.setSpan(RelativeSizeSpan(0.85f), headerStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        val codeStart = out.length
        out.append(CodeSyntaxHighlighter.highlight(code, lang))
        val codeEnd = out.length
        if (codeEnd > codeStart) {
            out.setSpan(TypefaceSpan("monospace"), codeStart, codeEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
            out.setSpan(BackgroundColorSpan(COLOR_CODE_BG), codeStart, codeEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
            out.setSpan(RelativeSizeSpan(0.92f), codeStart, codeEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
    }

    private fun appendParagraphLines(out: SpannableStringBuilder, lines: List<String>) {
        lines.forEachIndexed { idx, rawLine ->
            if (idx > 0) out.append('\n')
            val lineStart = out.length
            val trimmed = rawLine.trimStart()
            val indentSpaces = (rawLine.length - trimmed.length).coerceAtMost(8)
            val headingLevel = countHeadingHashes(trimmed)
            when {
                isHorizontalRule(trimmed) -> {
                    out.append("────────────")
                    out.setSpan(ForegroundColorSpan(COLOR_MUTED), lineStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                headingLevel in 1..6 -> {
                    appendInline(out, trimmed.substring(headingLevel + 1))
                    val sizeScale = when (headingLevel) {
                        1 -> 1.18f
                        2 -> 1.11f
                        3 -> 1.05f
                        else -> 1.01f
                    }
                    out.setSpan(StyleSpan(Typeface.BOLD), lineStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(ForegroundColorSpan(COLOR_HEADING), lineStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(RelativeSizeSpan(sizeScale), lineStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                trimmed.startsWith("> ") || trimmed == ">" -> {
                    val content = if (trimmed.length >= 2) trimmed.substring(2) else ""
                    val barStart = out.length
                    out.append("▎ ")
                    out.setSpan(ForegroundColorSpan(COLOR_QUOTE), barStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    val quoteTextStart = out.length
                    appendInline(out, content)
                    out.setSpan(ForegroundColorSpan(COLOR_QUOTE), quoteTextStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                else -> {
                    val task = parseTaskListPrefix(trimmed)
                    if (task != null) {
                        val indentPrefix = if (indentSpaces >= 2) "  ".repeat(indentSpaces / 2) else ""
                        out.append(indentPrefix)
                        val boxStart = out.length
                        out.append(if (task.checked) "☑ " else "☐ ")
                        out.setSpan(
                            ForegroundColorSpan(if (task.checked) COLOR_CHECK_DONE else COLOR_LINK),
                            boxStart,
                            out.length,
                            Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
                        )
                        val bodyStart = out.length
                        appendInline(out, task.rest)
                        if (task.checked && out.length > bodyStart) {
                            out.setSpan(ForegroundColorSpan(COLOR_MUTED), bodyStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                        }
                    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ") || trimmed.startsWith("+ ")) {
                        val indentLevel = (indentSpaces / 2).coerceIn(0, 3)
                        val bullet = if (indentLevel == 0) "• " else "◦ "
                        out.append("  ".repeat(indentLevel)).append(bullet)
                        appendInline(out, trimmed.substring(2))
                    } else {
                        val ordered = parseOrderedListPrefix(trimmed)
                        if (ordered != null) {
                            val indentLevel = (indentSpaces / 2).coerceIn(0, 3)
                            out.append("  ".repeat(indentLevel))
                            val numStart = out.length
                            out.append(ordered.first).append(' ')
                            out.setSpan(ForegroundColorSpan(COLOR_MUTED), numStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                            appendInline(out, ordered.second)
                        } else {
                            appendInline(out, rawLine)
                        }
                    }
                }
            }
        }
    }

    private fun countHeadingHashes(trimmed: String): Int {
        var count = 0
        while (count < trimmed.length && count < 6 && trimmed[count] == '#') count++
        if (count in 1..6 && count < trimmed.length && trimmed[count] == ' ') return count
        return 0
    }

    private fun appendInline(out: SpannableStringBuilder, text: String) {
        for (token in tokenizeInline(text)) {
            val spanStart = out.length
            when (token) {
                is InlineSpanToken.Plain -> out.append(token.text)
                is InlineSpanToken.Code -> {
                    out.append(' ').append(token.text).append(' ')
                    val spanEnd = out.length
                    out.setSpan(TypefaceSpan("monospace"), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(BackgroundColorSpan(COLOR_INLINE_CODE_BG), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(ForegroundColorSpan(COLOR_CODE_FG), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                is InlineSpanToken.Bold -> {
                    out.append(token.text)
                    val spanEnd = out.length
                    out.setSpan(StyleSpan(Typeface.BOLD), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(ForegroundColorSpan(COLOR_BOLD), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                is InlineSpanToken.Italic -> {
                    out.append(token.text)
                    val spanEnd = out.length
                    out.setSpan(StyleSpan(Typeface.ITALIC), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                is InlineSpanToken.BoldItalic -> {
                    out.append(token.text)
                    val spanEnd = out.length
                    out.setSpan(StyleSpan(Typeface.BOLD_ITALIC), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(ForegroundColorSpan(COLOR_BOLD), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                is InlineSpanToken.Strike -> {
                    out.append(token.text)
                    val spanEnd = out.length
                    out.setSpan(StrikethroughSpan(), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(ForegroundColorSpan(COLOR_MUTED), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                is InlineSpanToken.Link -> {
                    out.append(token.label)
                    val spanEnd = out.length
                    out.setSpan(URLSpan(token.url), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(ForegroundColorSpan(COLOR_LINK), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
            }
        }
    }
}
