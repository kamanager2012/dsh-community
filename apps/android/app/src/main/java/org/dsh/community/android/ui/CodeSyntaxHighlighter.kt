package org.dsh.community.android.ui

import android.graphics.Typeface
import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import org.dsh.community.android.protocol.DiffDisplayFormatter
import org.dsh.community.android.protocol.DiffLineKind

enum class SyntaxRole {
    KEYWORD,
    TYPE,
    STRING,
    NUMBER,
    COMMENT,
    ANNOTATION,
    KEY,
    FUNCTION,
    DIFF_HEADER,
    DIFF_HUNK,
    DIFF_ADD,
    DIFF_DEL,
    DIFF_CONTEXT,
}

data class SyntaxToken(
    val start: Int,
    val end: Int,
    val role: SyntaxRole,
)

/**
 * Dependency-free, linear-time O(N) syntax tokenizer and span applier for mobile code cards
 * and tool call/output inspection.
 */
object CodeSyntaxHighlighter {
    private const val MAX_HIGHLIGHT_CHARS = 24_000

    private const val COLOR_KEYWORD = 0xFFFF7B72.toInt()
    private const val COLOR_TYPE = 0xFFFFA657.toInt()
    private const val COLOR_STRING = 0xFFA5D6FF.toInt()
    private const val COLOR_NUMBER = 0xFF79C0FF.toInt()
    private const val COLOR_COMMENT = 0xFF8B949E.toInt()
    private const val COLOR_ANNOTATION = 0xFFD2A8FF.toInt()
    private const val COLOR_KEY = 0xFF7EE787.toInt()
    private const val COLOR_FUNCTION = 0xFFD2A8FF.toInt()

    private const val COLOR_DIFF_HDR_FG = 0xFF79C0FF.toInt()
    private const val COLOR_DIFF_HDR_BG = 0xFF131C2B.toInt()
    private const val COLOR_DIFF_HUNK_FG = 0xFFD2A8FF.toInt()
    private const val COLOR_DIFF_HUNK_BG = 0xFF1E1930.toInt()
    private const val COLOR_DIFF_ADD_FG = 0xFF7EE787.toInt()
    private const val COLOR_DIFF_ADD_BG = 0xFF14331C.toInt()
    private const val COLOR_DIFF_DEL_FG = 0xFFFFA198.toInt()
    private const val COLOR_DIFF_DEL_BG = 0xFF38171A.toInt()
    private const val COLOR_DIFF_CTX_FG = 0xFFB8C0CC.toInt()

    private enum class LangFamily {
        KOTLIN,
        JAVA,
        JS_TS,
        PYTHON,
        RUST,
        GO,
        SHELL,
        JSON,
        YAML_TOML,
        SQL,
        DIFF,
        PLAIN,
    }

    private val KOTLIN_KEYWORDS = setOf(
        "package", "import", "class", "interface", "object", "enum", "sealed", "data",
        "value", "fun", "val", "var", "const", "lateinit", "private", "protected", "public",
        "internal", "open", "abstract", "override", "final", "suspend", "inline", "tailrec",
        "operator", "infix", "companion", "init", "constructor", "if", "else", "when", "for",
        "while", "do", "return", "break", "continue", "throw", "try", "catch", "finally",
        "is", "in", "as", "by", "true", "false", "null", "this", "super", "it",
    )

    private val JAVA_KEYWORDS = setOf(
        "package", "import", "class", "interface", "enum", "record", "sealed", "extends",
        "implements", "private", "protected", "public", "static", "final", "abstract",
        "synchronized", "volatile", "void", "boolean", "byte", "short", "int", "long",
        "float", "double", "char", "if", "else", "switch", "case", "default", "for",
        "while", "do", "return", "break", "continue", "throw", "throws", "try", "catch",
        "finally", "new", "instanceof", "true", "false", "null", "this", "super", "var",
    )

    private val JS_TS_KEYWORDS = setOf(
        "import", "export", "from", "default", "as", "const", "let", "var", "function",
        "class", "interface", "type", "enum", "extends", "implements", "public", "private",
        "protected", "readonly", "static", "async", "await", "if", "else", "switch", "case",
        "for", "while", "do", "of", "in", "return", "break", "continue", "throw", "try",
        "catch", "finally", "new", "typeof", "instanceof", "keyof", "infer", "void", "never",
        "unknown", "any", "true", "false", "null", "undefined", "this", "super",
    )

    private val PYTHON_KEYWORDS = setOf(
        "import", "from", "as", "def", "class", "async", "await", "return", "yield", "if",
        "elif", "else", "for", "while", "break", "continue", "pass", "raise", "try",
        "except", "finally", "with", "lambda", "in", "is", "not", "and", "or", "global",
        "nonlocal", "assert", "del", "match", "case", "True", "False", "None", "self", "cls",
    )

    private val RUST_KEYWORDS = setOf(
        "use", "mod", "pub", "crate", "super", "self", "Self", "fn", "struct", "enum",
        "trait", "impl", "type", "where", "let", "mut", "const", "static", "ref", "async",
        "await", "move", "if", "else", "match", "for", "while", "loop", "in", "return",
        "break", "continue", "as", "dyn", "unsafe", "true", "false",
    )

    private val GO_KEYWORDS = setOf(
        "package", "import", "func", "type", "struct", "interface", "map", "chan", "var",
        "const", "if", "else", "switch", "case", "default", "select", "for", "range",
        "return", "break", "continue", "go", "defer", "fallthrough", "true", "false", "nil", "iota",
    )

    private val SHELL_KEYWORDS = setOf(
        "if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case",
        "esac", "in", "function", "select", "local", "export", "readonly", "unset", "return",
        "exit", "source", "true", "false", "echo", "cd", "git", "pnpm", "npm", "npx", "gradle",
    )

    private val SQL_KEYWORDS = setOf(
        "select", "from", "where", "join", "inner", "left", "right", "full", "outer", "on",
        "group", "by", "having", "order", "asc", "desc", "limit", "offset", "insert", "into",
        "values", "update", "set", "delete", "create", "alter", "drop", "table", "index",
        "view", "as", "distinct", "and", "or", "not", "in", "is", "null", "like", "between",
        "union", "all", "exists", "case", "when", "then", "else", "end", "count", "sum",
        "avg", "min", "max", "true", "false",
    )

    private val CONFIG_LITERALS = setOf("true", "false", "null", "yes", "no", "on", "off")

    fun normalizeLanguage(raw: String): String {
        val cleaned = raw.trim().lowercase()
        return when (cleaned) {
            "kt", "kts", "kotlin" -> "kotlin"
            "java" -> "java"
            "ts", "tsx", "mts", "cts", "typescript" -> "typescript"
            "js", "jsx", "mjs", "cjs", "javascript" -> "javascript"
            "py", "python" -> "python"
            "rs", "rust" -> "rust"
            "go", "golang" -> "go"
            "sh", "bash", "zsh", "shell", "fish", "console" -> "bash"
            "json", "jsonc", "json5" -> "json"
            "yml", "yaml" -> "yaml"
            "toml", "ini" -> "toml"
            "sql", "sqlite", "postgres", "postgresql" -> "sql"
            "diff", "patch", "udiff" -> "diff"
            else -> cleaned
        }
    }

    private fun resolveFamily(language: String): LangFamily = when (normalizeLanguage(language)) {
        "kotlin" -> LangFamily.KOTLIN
        "java" -> LangFamily.JAVA
        "typescript", "javascript" -> LangFamily.JS_TS
        "python" -> LangFamily.PYTHON
        "rust" -> LangFamily.RUST
        "go" -> LangFamily.GO
        "bash" -> LangFamily.SHELL
        "json" -> LangFamily.JSON
        "yaml", "toml" -> LangFamily.YAML_TOML
        "sql" -> LangFamily.SQL
        "diff" -> LangFamily.DIFF
        else -> LangFamily.PLAIN
    }

    fun tokenize(code: String, language: String = ""): List<SyntaxToken> {
        if (code.isEmpty()) return emptyList()
        val boundedLen = minOf(code.length, MAX_HIGHLIGHT_CHARS)
        val family = resolveFamily(language)
        if (family == LangFamily.DIFF) {
            return tokenizeDiff(code, boundedLen)
        }

        val tokens = ArrayList<SyntaxToken>()
        val keywords = keywordsFor(family)
        val supportsSlashComments = family in setOf(
            LangFamily.KOTLIN,
            LangFamily.JAVA,
            LangFamily.JS_TS,
            LangFamily.RUST,
            LangFamily.GO,
            LangFamily.JSON,
        )
        val supportsHashComments = family in setOf(
            LangFamily.PYTHON,
            LangFamily.SHELL,
            LangFamily.YAML_TOML,
        )
        val supportsDashComments = family == LangFamily.SQL

        var i = 0
        var lineStart = true
        while (i < boundedLen) {
            val ch = code[i]
            if (ch == '\n' || ch == '\r') {
                lineStart = true
                i++
                continue
            }
            if (ch == ' ' || ch == '\t') {
                i++
                continue
            }

            // Line comments
            if ((supportsSlashComments && ch == '/' && i + 1 < boundedLen && code[i + 1] == '/') ||
                (supportsHashComments && ch == '#') ||
                (supportsDashComments && ch == '-' && i + 1 < boundedLen && code[i + 1] == '-')
            ) {
                val end = findLineEnd(code, i, boundedLen)
                tokens.add(SyntaxToken(i, end, SyntaxRole.COMMENT))
                i = end
                lineStart = false
                continue
            }

            // Block comments
            if ((supportsSlashComments || family == LangFamily.SQL) &&
                ch == '/' && i + 1 < boundedLen && code[i + 1] == '*'
            ) {
                val end = findBlockCommentEnd(code, i + 2, boundedLen)
                tokens.add(SyntaxToken(i, end, SyntaxRole.COMMENT))
                i = end
                lineStart = false
                continue
            }

            // Triple-quoted strings (Kotlin / Python)
            if ((family == LangFamily.KOTLIN || family == LangFamily.PYTHON) &&
                (ch == '"' || ch == '\'') &&
                i + 2 < boundedLen &&
                code[i + 1] == ch &&
                code[i + 2] == ch
            ) {
                val end = findTripleQuotedEnd(code, i + 3, ch, boundedLen)
                tokens.add(SyntaxToken(i, end, SyntaxRole.STRING))
                i = end
                lineStart = false
                continue
            }

            // Single / double / backtick quoted strings (and JSON object keys)
            if (ch == '"' || ch == '\'' || (ch == '`' && family in setOf(LangFamily.JS_TS, LangFamily.GO, LangFamily.SHELL, LangFamily.SQL))) {
                val end = findQuotedStringEnd(code, i, ch, boundedLen)
                val isJsonKey = family == LangFamily.JSON && ch == '"' && isFollowedByColon(code, end, boundedLen)
                tokens.add(SyntaxToken(i, end, if (isJsonKey) SyntaxRole.KEY else SyntaxRole.STRING))
                i = end
                lineStart = false
                continue
            }

            // Annotations / shell variables
            if (ch == '@' && family in setOf(LangFamily.KOTLIN, LangFamily.JAVA, LangFamily.PYTHON, LangFamily.JS_TS)) {
                val end = scanIdentEnd(code, i + 1, boundedLen)
                if (end > i + 1) {
                    tokens.add(SyntaxToken(i, end, SyntaxRole.ANNOTATION))
                    i = end
                    lineStart = false
                    continue
                }
            }
            if (ch == '$' && family == LangFamily.SHELL) {
                val end = if (i + 1 < boundedLen && code[i + 1] == '{') {
                    val close = code.indexOf('}', i + 2)
                    if (close in (i + 2) until boundedLen) close + 1 else i + 2
                } else {
                    scanIdentEnd(code, i + 1, boundedLen)
                }
                if (end > i + 1) {
                    tokens.add(SyntaxToken(i, end, SyntaxRole.ANNOTATION))
                    i = end
                    lineStart = false
                    continue
                }
            }

            // Shell --long-flag or -f
            if (family == LangFamily.SHELL && ch == '-' && i + 1 < boundedLen &&
                (code[i + 1] == '-' || code[i + 1].isLetter())
            ) {
                var end = i + 1
                while (end < boundedLen && (code[end].isLetterOrDigit() || code[end] == '-' || code[end] == '_')) {
                    end++
                }
                tokens.add(SyntaxToken(i, end, SyntaxRole.TYPE))
                i = end
                lineStart = false
                continue
            }

            // TOML [section] headers
            if (family == LangFamily.YAML_TOML && lineStart && ch == '[') {
                val close = code.indexOf(']', i + 1)
                if (close in (i + 1) until boundedLen && !code.substring(i, close).contains('\n')) {
                    val end = if (close + 1 < boundedLen && code[close + 1] == ']') close + 2 else close + 1
                    tokens.add(SyntaxToken(i, end, SyntaxRole.ANNOTATION))
                    i = end
                    lineStart = false
                    continue
                }
            }

            // Numbers
            if (ch.isDigit() || (ch == '-' && i + 1 < boundedLen && code[i + 1].isDigit() && family == LangFamily.JSON)) {
                val end = scanNumberEnd(code, if (ch == '-') i + 1 else i, boundedLen)
                tokens.add(SyntaxToken(i, end, SyntaxRole.NUMBER))
                i = end
                lineStart = false
                continue
            }

            // Identifiers, YAML/TOML keys, keywords, types, functions
            if (ch.isLetter() || ch == '_') {
                val end = scanIdentEnd(code, i, boundedLen)
                val word = code.substring(i, end)
                val role: SyntaxRole? = when {
                    family == LangFamily.YAML_TOML &&
                        (isFollowedByColon(code, end, boundedLen) || isFollowedByEquals(code, end, boundedLen)) -> SyntaxRole.KEY
                    family == LangFamily.SQL && word.lowercase() in SQL_KEYWORDS -> SyntaxRole.KEYWORD
                    family in setOf(LangFamily.JSON, LangFamily.YAML_TOML) && word.lowercase() in CONFIG_LITERALS -> SyntaxRole.KEYWORD
                    word in keywords -> SyntaxRole.KEYWORD
                    family != LangFamily.PLAIN && isFollowedByOpenParen(code, end, boundedLen) -> SyntaxRole.FUNCTION
                    family !in setOf(LangFamily.PLAIN, LangFamily.SHELL, LangFamily.SQL, LangFamily.JSON, LangFamily.YAML_TOML) &&
                        word.isNotEmpty() && word[0].isUpperCase() && word.any { it.isLowerCase() } -> SyntaxRole.TYPE
                    else -> null
                }
                if (role != null) {
                    tokens.add(SyntaxToken(i, end, role))
                }
                i = end
                lineStart = false
                continue
            }

            lineStart = false
            i++
        }
        return tokens
    }

    fun highlight(code: String, language: String = ""): CharSequence {
        if (code.isEmpty()) return ""
        val builder = SpannableStringBuilder(code)
        val tokens = tokenize(code, language)
        for (tok in tokens) {
            if (tok.start < 0 || tok.end > builder.length || tok.start >= tok.end) continue
            when (tok.role) {
                SyntaxRole.KEYWORD -> {
                    builder.setSpan(ForegroundColorSpan(COLOR_KEYWORD), tok.start, tok.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    builder.setSpan(StyleSpan(Typeface.BOLD), tok.start, tok.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                SyntaxRole.TYPE -> {
                    builder.setSpan(ForegroundColorSpan(COLOR_TYPE), tok.start, tok.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                SyntaxRole.STRING -> {
                    builder.setSpan(ForegroundColorSpan(COLOR_STRING), tok.start, tok.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                SyntaxRole.NUMBER -> {
                    builder.setSpan(ForegroundColorSpan(COLOR_NUMBER), tok.start, tok.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                SyntaxRole.COMMENT -> {
                    builder.setSpan(ForegroundColorSpan(COLOR_COMMENT), tok.start, tok.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    builder.setSpan(StyleSpan(Typeface.ITALIC), tok.start, tok.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                SyntaxRole.ANNOTATION -> {
                    builder.setSpan(ForegroundColorSpan(COLOR_ANNOTATION), tok.start, tok.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                SyntaxRole.KEY -> {
                    builder.setSpan(ForegroundColorSpan(COLOR_KEY), tok.start, tok.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                SyntaxRole.FUNCTION -> {
                    builder.setSpan(ForegroundColorSpan(COLOR_FUNCTION), tok.start, tok.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                SyntaxRole.DIFF_HEADER -> {
                    builder.setSpan(ForegroundColorSpan(COLOR_DIFF_HDR_FG), tok.start, tok.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    builder.setSpan(BackgroundColorSpan(COLOR_DIFF_HDR_BG), tok.start, tok.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    builder.setSpan(StyleSpan(Typeface.BOLD), tok.start, tok.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                SyntaxRole.DIFF_HUNK -> {
                    builder.setSpan(ForegroundColorSpan(COLOR_DIFF_HUNK_FG), tok.start, tok.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    builder.setSpan(BackgroundColorSpan(COLOR_DIFF_HUNK_BG), tok.start, tok.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                SyntaxRole.DIFF_ADD -> {
                    builder.setSpan(ForegroundColorSpan(COLOR_DIFF_ADD_FG), tok.start, tok.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    builder.setSpan(BackgroundColorSpan(COLOR_DIFF_ADD_BG), tok.start, tok.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                SyntaxRole.DIFF_DEL -> {
                    builder.setSpan(ForegroundColorSpan(COLOR_DIFF_DEL_FG), tok.start, tok.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                    builder.setSpan(BackgroundColorSpan(COLOR_DIFF_DEL_BG), tok.start, tok.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                SyntaxRole.DIFF_CONTEXT -> {
                    builder.setSpan(ForegroundColorSpan(COLOR_DIFF_CTX_FG), tok.start, tok.end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
            }
        }
        return builder
    }

    private fun tokenizeDiff(code: String, boundedLen: Int): List<SyntaxToken> {
        val tokens = ArrayList<SyntaxToken>()
        var lineStart = 0
        while (lineStart < boundedLen) {
            var lineEnd = code.indexOf('\n', lineStart)
            if (lineEnd < 0 || lineEnd > boundedLen) lineEnd = boundedLen
            val line = code.substring(lineStart, lineEnd)
            val role = when (DiffDisplayFormatter.classifyLine(line)) {
                DiffLineKind.FILE_HEADER -> SyntaxRole.DIFF_HEADER
                DiffLineKind.HUNK -> SyntaxRole.DIFF_HUNK
                DiffLineKind.ADD -> SyntaxRole.DIFF_ADD
                DiffLineKind.DEL -> SyntaxRole.DIFF_DEL
                DiffLineKind.CONTEXT -> SyntaxRole.DIFF_CONTEXT
            }
            if (lineEnd > lineStart) {
                tokens.add(SyntaxToken(lineStart, lineEnd, role))
            }
            if (lineEnd >= boundedLen) break
            lineStart = lineEnd + 1
        }
        return tokens
    }

    private fun keywordsFor(family: LangFamily): Set<String> = when (family) {
        LangFamily.KOTLIN -> KOTLIN_KEYWORDS
        LangFamily.JAVA -> JAVA_KEYWORDS
        LangFamily.JS_TS -> JS_TS_KEYWORDS
        LangFamily.PYTHON -> PYTHON_KEYWORDS
        LangFamily.RUST -> RUST_KEYWORDS
        LangFamily.GO -> GO_KEYWORDS
        LangFamily.SHELL -> SHELL_KEYWORDS
        LangFamily.SQL -> SQL_KEYWORDS
        LangFamily.JSON, LangFamily.YAML_TOML, LangFamily.DIFF, LangFamily.PLAIN -> emptySet()
    }

    private fun findLineEnd(code: String, start: Int, limit: Int): Int {
        var i = start
        while (i < limit && code[i] != '\n' && code[i] != '\r') i++
        return i
    }

    private fun findBlockCommentEnd(code: String, start: Int, limit: Int): Int {
        var i = start
        while (i + 1 < limit) {
            if (code[i] == '*' && code[i + 1] == '/') return i + 2
            i++
        }
        return limit
    }

    private fun findTripleQuotedEnd(code: String, start: Int, quote: Char, limit: Int): Int {
        var i = start
        while (i + 2 < limit) {
            if (code[i] == '\\') {
                i += 2
                continue
            }
            if (code[i] == quote && code[i + 1] == quote && code[i + 2] == quote) {
                return i + 3
            }
            i++
        }
        return limit
    }

    private fun findQuotedStringEnd(code: String, start: Int, quote: Char, limit: Int): Int {
        var i = start + 1
        while (i < limit) {
            val ch = code[i]
            if (ch == '\\') {
                i += 2
                continue
            }
            if (ch == quote) return i + 1
            if (ch == '\n' && quote != '`') return i
            i++
        }
        return limit
    }

    private fun scanIdentEnd(code: String, start: Int, limit: Int): Int {
        var i = start
        while (i < limit && (code[i].isLetterOrDigit() || code[i] == '_')) i++
        return i
    }

    private fun scanNumberEnd(code: String, start: Int, limit: Int): Int {
        var i = start
        if (i + 1 < limit && code[i] == '0' && (code[i + 1] == 'x' || code[i + 1] == 'X' || code[i + 1] == 'b' || code[i + 1] == 'B')) {
            i += 2
            while (i < limit && (code[i].isDigit() || code[i] in 'a'..'f' || code[i] in 'A'..'F' || code[i] == '_')) i++
            return i
        }
        while (i < limit && (code[i].isDigit() || code[i] == '_' || code[i] == '.')) i++
        while (i < limit && code[i] in charArrayOf('f', 'F', 'l', 'L', 'u', 'U')) i++
        return i
    }

    private fun isFollowedByColon(code: String, pos: Int, limit: Int): Boolean {
        var i = pos
        while (i < limit && (code[i] == ' ' || code[i] == '\t')) i++
        return i < limit && code[i] == ':'
    }

    private fun isFollowedByEquals(code: String, pos: Int, limit: Int): Boolean {
        var i = pos
        while (i < limit && (code[i] == ' ' || code[i] == '\t')) i++
        return i < limit && code[i] == '='
    }

    private fun isFollowedByOpenParen(code: String, pos: Int, limit: Int): Boolean {
        var i = pos
        while (i < limit && (code[i] == ' ' || code[i] == '\t')) i++
        return i < limit && code[i] == '('
    }
}
