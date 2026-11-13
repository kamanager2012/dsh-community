package org.dsh.community.android.protocol

/**
 * Dependency-free strict RFC 8259 JSON codec so protocol, QR descriptor, and interop code
 * behaves identically on Android ART and JVM unit tests without `org.json` stub differences.
 */
sealed interface JsonValue {
    fun stringify(): String
}

data class JsonObject(val fields: Map<String, JsonValue>) : JsonValue {
    fun str(key: String): String? = (fields[key] as? JsonString)?.value
    fun bool(key: String): Boolean? = (fields[key] as? JsonBool)?.value
    fun num(key: String): Double? = (fields[key] as? JsonNumber)?.value
    fun longVal(key: String): Long? = (fields[key] as? JsonNumber)?.asLongOrNull()
    fun intVal(key: String): Int? = (fields[key] as? JsonNumber)?.asIntOrNull()
    fun obj(key: String): JsonObject? = fields[key] as? JsonObject
    fun arr(key: String): JsonArray? = fields[key] as? JsonArray

    override fun stringify(): String = buildString {
        append('{')
        var first = true
        for ((k, v) in fields) {
            if (!first) append(',')
            first = false
            appendQuotedString(this, k)
            append(':')
            append(v.stringify())
        }
        append('}')
    }

    companion object {
        fun of(vararg pairs: Pair<String, JsonValue?>): JsonObject {
            val map = LinkedHashMap<String, JsonValue>()
            for ((k, v) in pairs) {
                if (v != null) map[k] = v
            }
            return JsonObject(map)
        }
    }
}

data class JsonArray(val items: List<JsonValue>) : JsonValue {
    override fun stringify(): String = buildString {
        append('[')
        for (i in items.indices) {
            if (i > 0) append(',')
            append(items[i].stringify())
        }
        append(']')
    }
}

data class JsonString(val value: String) : JsonValue {
    override fun stringify(): String = buildString { appendQuotedString(this, value) }
}

data class JsonNumber(val value: Double, val raw: String? = null) : JsonValue {
    constructor(v: Int) : this(v.toDouble(), v.toString())
    constructor(v: Long) : this(v.toDouble(), v.toString())

    fun asLongOrNull(): Long? {
        if (!value.isFinite() || value % 1.0 != 0.0) return null
        if (raw != null && !raw.contains('.') && !raw.contains('e') && !raw.contains('E')) {
            return raw.toLongOrNull()
        }
        if (value < Long.MIN_VALUE.toDouble() || value > Long.MAX_VALUE.toDouble()) return null
        return value.toLong()
    }

    fun asIntOrNull(): Int? {
        val l = asLongOrNull() ?: return null
        return if (l in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong()) l.toInt() else null
    }

    override fun stringify(): String {
        if (raw != null) return raw
        if (!value.isFinite()) throw IllegalArgumentException("non-finite JSON number: $value")
        val asLong = asLongOrNull()
        return asLong?.toString() ?: value.toString()
    }
}

data class JsonBool(val value: Boolean) : JsonValue {
    override fun stringify(): String = if (value) "true" else "false"
}

data object JsonNull : JsonValue {
    override fun stringify(): String = "null"
}

private fun appendQuotedString(sb: StringBuilder, s: String) {
    sb.append('"')
    for (ch in s) {
        when (ch) {
            '"' -> sb.append("\\\"")
            '\\' -> sb.append("\\\\")
            '\b' -> sb.append("\\b")
            '\u000C' -> sb.append("\\f")
            '\n' -> sb.append("\\n")
            '\r' -> sb.append("\\r")
            '\t' -> sb.append("\\t")
            else -> {
                val code = ch.code
                if (code < 0x20) {
                    sb.append(String.format("\\u%04x", code))
                } else {
                    sb.append(ch)
                }
            }
        }
    }
    sb.append('"')
}

object JsonCodec {
    fun parse(input: String): JsonValue {
        val parser = Parser(input)
        val v = parser.parseValue()
        parser.skipWhitespace()
        if (!parser.eof()) {
            throw IllegalArgumentException("unexpected trailing content in JSON at pos ${parser.pos}")
        }
        return v
    }

    fun parseObject(input: String): JsonObject =
        parse(input) as? JsonObject ?: throw IllegalArgumentException("JSON root must be an object")

    private class Parser(private val src: String) {
        var pos: Int = 0

        fun eof(): Boolean = pos >= src.length

        fun skipWhitespace() {
            while (pos < src.length) {
                when (src[pos]) {
                    ' ', '\t', '\r', '\n' -> pos++
                    else -> return
                }
            }
        }

        fun parseValue(): JsonValue {
            skipWhitespace()
            if (eof()) throw IllegalArgumentException("unexpected EOF in JSON")
            return when (val c = src[pos]) {
                '{' -> parseObject()
                '[' -> parseArray()
                '"' -> JsonString(parseString())
                't', 'f' -> parseBoolean()
                'n' -> parseNull()
                '-', in '0'..'9' -> parseNumber()
                else -> throw IllegalArgumentException("unexpected char '$c' at pos $pos")
            }
        }

        private fun parseObject(): JsonObject {
            expect('{')
            skipWhitespace()
            val map = LinkedHashMap<String, JsonValue>()
            if (peek() == '}') {
                pos++
                return JsonObject(map)
            }
            while (true) {
                skipWhitespace()
                if (peek() != '"') throw IllegalArgumentException("expected object key at pos $pos")
                val key = parseString()
                skipWhitespace()
                expect(':')
                val value = parseValue()
                map[key] = value
                skipWhitespace()
                when (peek()) {
                    ',' -> pos++
                    '}' -> {
                        pos++
                        return JsonObject(map)
                    }
                    else -> throw IllegalArgumentException("expected ',' or '}' at pos $pos")
                }
            }
        }

        private fun parseArray(): JsonArray {
            expect('[')
            skipWhitespace()
            val list = ArrayList<JsonValue>()
            if (peek() == ']') {
                pos++
                return JsonArray(list)
            }
            while (true) {
                list.add(parseValue())
                skipWhitespace()
                when (peek()) {
                    ',' -> pos++
                    ']' -> {
                        pos++
                        return JsonArray(list)
                    }
                    else -> throw IllegalArgumentException("expected ',' or ']' at pos $pos")
                }
            }
        }

        private fun parseString(): String {
            expect('"')
            val sb = StringBuilder()
            while (pos < src.length) {
                val c = src[pos++]
                when (c) {
                    '"' -> return sb.toString()
                    '\\' -> {
                        if (pos >= src.length) throw IllegalArgumentException("unterminated escape")
                        when (val esc = src[pos++]) {
                            '"' -> sb.append('"')
                            '\\' -> sb.append('\\')
                            '/' -> sb.append('/')
                            'b' -> sb.append('\b')
                            'f' -> sb.append('\u000C')
                            'n' -> sb.append('\n')
                            'r' -> sb.append('\r')
                            't' -> sb.append('\t')
                            'u' -> {
                                if (pos + 4 > src.length) throw IllegalArgumentException("short \\u escape")
                                val hex = src.substring(pos, pos + 4)
                                pos += 4
                                val code = hex.toInt(16)
                                sb.append(code.toChar())
                            }
                            else -> throw IllegalArgumentException("invalid JSON escape '\\$esc'")
                        }
                    }
                    else -> {
                        if (c.code < 0x20) {
                            throw IllegalArgumentException("unescaped control char in JSON string")
                        }
                        sb.append(c)
                    }
                }
            }
            throw IllegalArgumentException("unterminated JSON string")
        }

        private fun parseBoolean(): JsonBool {
            return if (src.startsWith("true", pos)) {
                pos += 4
                JsonBool(true)
            } else if (src.startsWith("false", pos)) {
                pos += 5
                JsonBool(false)
            } else {
                throw IllegalArgumentException("invalid boolean literal at pos $pos")
            }
        }

        private fun parseNull(): JsonNull {
            if (!src.startsWith("null", pos)) {
                throw IllegalArgumentException("invalid null literal at pos $pos")
            }
            pos += 4
            return JsonNull
        }

        private fun parseNumber(): JsonNumber {
            val start = pos
            if (src[pos] == '-') pos++
            if (pos >= src.length || src[pos] !in '0'..'9') {
                throw IllegalArgumentException("invalid JSON number at pos $start")
            }
            if (src[pos] == '0') {
                pos++
            } else {
                while (pos < src.length && src[pos] in '0'..'9') pos++
            }
            if (pos < src.length && src[pos] == '.') {
                pos++
                if (pos >= src.length || src[pos] !in '0'..'9') {
                    throw IllegalArgumentException("invalid fraction in JSON number at pos $start")
                }
                while (pos < src.length && src[pos] in '0'..'9') pos++
            }
            if (pos < src.length && (src[pos] == 'e' || src[pos] == 'E')) {
                pos++
                if (pos < src.length && (src[pos] == '+' || src[pos] == '-')) pos++
                if (pos >= src.length || src[pos] !in '0'..'9') {
                    throw IllegalArgumentException("invalid exponent in JSON number at pos $start")
                }
                while (pos < src.length && src[pos] in '0'..'9') pos++
            }
            val raw = src.substring(start, pos)
            val parsed = raw.toDoubleOrNull()
                ?: throw IllegalArgumentException("unparseable JSON number '$raw'")
            return JsonNumber(parsed, raw)
        }

        private fun peek(): Char {
            if (pos >= src.length) throw IllegalArgumentException("unexpected EOF in JSON")
            return src[pos]
        }

        private fun expect(expected: Char) {
            if (pos >= src.length || src[pos] != expected) {
                throw IllegalArgumentException("expected '$expected' at pos $pos")
            }
            pos++
        }
    }
}
