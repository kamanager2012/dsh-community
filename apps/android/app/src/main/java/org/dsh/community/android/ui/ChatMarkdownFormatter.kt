package org.dsh.community.android.ui

import android.graphics.Color
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
import android.text.style.UnderlineSpan

sealed interface MarkdownBlock {
    data class CodeFence(val language: String, val code: String) : MarkdownBlock
    data class ParagraphLines(val lines: List<String>) : MarkdownBlock
}

sealed interface InlineSpanToken {
    data class Plain(val text: String) : InlineSpanToken
    data class Bold(val text: String) : InlineSpanToken
    data class Italic(val text: String) : InlineSpanToken
    data class Code(val text: String) : InlineSpanToken
    data class Strike(val text: String) : InlineSpanToken
    data class Link(val label: String, val url: String) : InlineSpanToken
}

/**
 * Lightweight, WebView-free Markdown -> Android [SpannableStringBuilder] formatter.
 * Supports fenced code blocks, headings, bullets, blockquotes, inline code, bold, and italic.
 */
object ChatMarkdownFormatter {
    private val COLOR_CODE_BG = Color.parseColor("#0B0E14")
    private val COLOR_CODE_FG = Color.parseColor("#79C0FF")
    private val COLOR_INLINE_CODE_BG = Color.parseColor("#21262D")
    private val COLOR_HEADING = Color.parseColor("#F0F6FC")
    private val COLOR_MUTED = Color.parseColor("#8B949E")
    private val COLOR_BOLD = Color.parseColor("#FFFFFF")
    private val COLOR_QUOTE = Color.parseColor("#A5D6FF")
    private val COLOR_LINK = Color.parseColor("#58A6FF")

    fun extractFirstCodeBlock(markdown: String): String? =
        parseBlocks(markdown)
            .filterIsInstance<MarkdownBlock.CodeFence>()
            .firstOrNull { it.code.isNotBlank() }
            ?.code

    fun isHorizontalRule(line: String): Boolean {
        val compact = line.trim().replace(" ", "")
        return compact.length >= 3 && (compact.all { it == '-' } || compact.all { it == '*' } || compact.all { it == '_' })
    }

    fun parseOrderedListPrefix(trimmedLine: String): Pair<String, String>? {
        val dotIdx = trimmedLine.indexOf('.')
        if (dotIdx <= 0 || dotIdx > 4) return null
        val digits = trimmedLine.substring(0, dotIdx)
        if (!digits.all { it.isDigit() }) return null
        if (dotIdx + 1 >= trimmedLine.length || trimmedLine[dotIdx + 1] != ' ') return null
        val rest = trimmedLine.substring(dotIdx + 2)
        return "$digits." to rest
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
            if (text.startsWith("**", i)) {
                val end = text.indexOf("**", i + 2)
                if (end > i + 2) {
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
                        if (url.startsWith("https://") || url.startsWith("http://")) {
                            flushPlain()
                            tokens.add(InlineSpanToken.Link(label, url))
                            i = closeParen + 1
                            continue
                        }
                    }
                }
            }
            if (text[i] == '*' && !text.startsWith("**", i) && i + 1 < text.length && text[i + 1] != ' ') {
                val end = text.indexOf('*', i + 1)
                if (end > i + 1 && text[end - 1] != ' ') {
                    flushPlain()
                    tokens.add(InlineSpanToken.Italic(text.substring(i + 1, end)))
                    i = end + 1
                    continue
                }
            }
            plain.append(text[i])
            i += 1
        }
        flushPlain()
        return tokens
    }

    fun parseBlocks(markdown: String): List<MarkdownBlock> {
        val lines = markdown.replace("\r\n", "\n").replace('\r', '\n').split('\n')
        val blocks = ArrayList<MarkdownBlock>()
        var inCode = false
        var codeLang = ""
        val codeBuf = ArrayList<String>()
        val paraBuf = ArrayList<String>()

        fun flushPara() {
            if (paraBuf.isNotEmpty()) {
                blocks.add(MarkdownBlock.ParagraphLines(paraBuf.toList()))
                paraBuf.clear()
            }
        }

        fun flushCode() {
            blocks.add(MarkdownBlock.CodeFence(codeLang, codeBuf.joinToString("\n")))
            codeBuf.clear()
            codeLang = ""
        }

        for (line in lines) {
            val trimmed = line.trimStart()
            if (trimmed.startsWith("```")) {
                if (!inCode) {
                    flushPara()
                    inCode = true
                    codeLang = trimmed.removePrefix("```").trim()
                } else {
                    flushCode()
                    inCode = false
                }
            } else if (inCode) {
                codeBuf.add(line)
            } else {
                paraBuf.add(line)
            }
        }
        if (inCode) {
            flushCode()
        } else {
            flushPara()
        }
        return blocks
    }

    fun format(markdown: String): CharSequence {
        if (markdown.isEmpty()) return ""
        val blocks = parseBlocks(markdown)
        val out = SpannableStringBuilder()
        blocks.forEachIndexed { bIdx, block ->
            if (bIdx > 0) out.append('\n')
            when (block) {
                is MarkdownBlock.CodeFence -> appendCodeFence(out, block.language, block.code)
                is MarkdownBlock.ParagraphLines -> appendParagraphLines(out, block.lines)
            }
        }
        return out
    }

    private fun appendCodeFence(out: SpannableStringBuilder, lang: String, code: String) {
        if (lang.isNotEmpty()) {
            val headerStart = out.length
            out.append("[$lang]\n")
            out.setSpan(ForegroundColorSpan(COLOR_MUTED), headerStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
            out.setSpan(RelativeSizeSpan(0.82f), headerStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        val codeStart = out.length
        out.append(code.ifEmpty { " " })
        val codeEnd = out.length
        out.setSpan(TypefaceSpan("monospace"), codeStart, codeEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
        out.setSpan(RelativeSizeSpan(0.88f), codeStart, codeEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
        out.setSpan(ForegroundColorSpan(COLOR_CODE_FG), codeStart, codeEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
        out.setSpan(BackgroundColorSpan(COLOR_CODE_BG), codeStart, codeEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
    }

    private fun appendParagraphLines(out: SpannableStringBuilder, lines: List<String>) {
        lines.forEachIndexed { idx, rawLine ->
            if (idx > 0) out.append('\n')
            val lineStart = out.length
            val trimmed = rawLine.trimStart()
            when {
                trimmed.startsWith("### ") -> {
                    appendInline(out, trimmed.removePrefix("### "))
                    out.setSpan(StyleSpan(Typeface.BOLD), lineStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(RelativeSizeSpan(1.06f), lineStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(ForegroundColorSpan(COLOR_HEADING), lineStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                trimmed.startsWith("## ") -> {
                    appendInline(out, trimmed.removePrefix("## "))
                    out.setSpan(StyleSpan(Typeface.BOLD), lineStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(RelativeSizeSpan(1.13f), lineStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(ForegroundColorSpan(COLOR_HEADING), lineStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                trimmed.startsWith("# ") -> {
                    appendInline(out, trimmed.removePrefix("# "))
                    out.setSpan(StyleSpan(Typeface.BOLD), lineStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(RelativeSizeSpan(1.22f), lineStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(ForegroundColorSpan(COLOR_HEADING), lineStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                isHorizontalRule(trimmed) -> {
                    out.append("────────────────────────")
                    out.setSpan(ForegroundColorSpan(COLOR_MUTED), lineStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                trimmed.startsWith("> ") -> {
                    out.append("│ ")
                    appendInline(out, trimmed.removePrefix("> "))
                    out.setSpan(ForegroundColorSpan(COLOR_QUOTE), lineStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(StyleSpan(Typeface.ITALIC), lineStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                trimmed.startsWith("- ") || trimmed.startsWith("* ") -> {
                    val indent = rawLine.length - trimmed.length
                    if (indent > 0) out.append(" ".repeat(minOf(indent, 6)))
                    out.append("• ")
                    appendInline(out, trimmed.substring(2))
                }
                else -> {
                    val ordered = parseOrderedListPrefix(trimmed)
                    if (ordered != null) {
                        val indent = rawLine.length - trimmed.length
                        if (indent > 0) out.append(" ".repeat(minOf(indent, 6)))
                        val numStart = out.length
                        out.append(ordered.first).append(' ')
                        out.setSpan(ForegroundColorSpan(COLOR_LINK), numStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                        out.setSpan(StyleSpan(Typeface.BOLD), numStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                        appendInline(out, ordered.second)
                    } else {
                        appendInline(out, rawLine)
                    }
                }
            }
        }
    }

    private fun appendInline(out: SpannableStringBuilder, text: String) {
        for (token in tokenizeInline(text)) {
            val spanStart = out.length
            when (token) {
                is InlineSpanToken.Plain -> out.append(token.text)
                is InlineSpanToken.Code -> {
                    out.append(token.text)
                    val spanEnd = out.length
                    out.setSpan(TypefaceSpan("monospace"), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(RelativeSizeSpan(0.92f), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(ForegroundColorSpan(COLOR_CODE_FG), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(BackgroundColorSpan(COLOR_INLINE_CODE_BG), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                is InlineSpanToken.Bold -> {
                    appendInline(out, token.text)
                    val spanEnd = out.length
                    out.setSpan(StyleSpan(Typeface.BOLD), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(ForegroundColorSpan(COLOR_BOLD), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                is InlineSpanToken.Italic -> {
                    out.append(token.text)
                    out.setSpan(StyleSpan(Typeface.ITALIC), spanStart, out.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
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
                    out.setSpan(UnderlineSpan(), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
            }
        }
    }
}
