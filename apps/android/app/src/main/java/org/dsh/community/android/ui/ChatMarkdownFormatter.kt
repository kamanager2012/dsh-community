package org.dsh.community.android.ui

import android.graphics.Color
import android.graphics.Typeface
import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan

sealed interface MarkdownBlock {
    data class CodeFence(val language: String, val code: String) : MarkdownBlock
    data class ParagraphLines(val lines: List<String>) : MarkdownBlock
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
                else -> appendInline(out, rawLine)
            }
        }
    }

    private fun appendInline(out: SpannableStringBuilder, text: String) {
        var i = 0
        val n = text.length
        while (i < n) {
            if (text[i] == '`') {
                val close = text.indexOf('`', i + 1)
                if (close > i + 1) {
                    val spanStart = out.length
                    out.append(text, i + 1, close)
                    val spanEnd = out.length
                    out.setSpan(TypefaceSpan("monospace"), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(RelativeSizeSpan(0.92f), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(ForegroundColorSpan(COLOR_CODE_FG), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(BackgroundColorSpan(COLOR_INLINE_CODE_BG), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    i = close + 1
                    continue
                }
            }
            if (i + 1 < n && text[i] == '*' && text[i + 1] == '*') {
                val close = text.indexOf("**", i + 2)
                if (close > i + 2) {
                    val spanStart = out.length
                    appendInline(out, text.substring(i + 2, close))
                    val spanEnd = out.length
                    out.setSpan(StyleSpan(Typeface.BOLD), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(ForegroundColorSpan(COLOR_BOLD), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    i = close + 2
                    continue
                }
            }
            if (text[i] == '*' && (i + 1 < n && text[i + 1] != ' ' && text[i + 1] != '*')) {
                val close = text.indexOf('*', i + 1)
                if (close > i + 1 && text[close - 1] != ' ') {
                    val spanStart = out.length
                    out.append(text, i + 1, close)
                    val spanEnd = out.length
                    out.setSpan(StyleSpan(Typeface.ITALIC), spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    i = close + 1
                    continue
                }
            }
            out.append(text[i])
            i++
        }
    }
}
