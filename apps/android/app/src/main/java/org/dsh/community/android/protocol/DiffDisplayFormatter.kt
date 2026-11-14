package org.dsh.community.android.protocol

enum class DiffLineKind {
    FILE_HEADER,
    HUNK,
    ADD,
    DEL,
    CONTEXT,
}

data class ClassifiedDiffLine(
    val text: String,
    val kind: DiffLineKind,
)

data class DiffLineStats(
    val additions: Int,
    val deletions: Int,
    val hunks: Int,
)

/** Classifies unified diff lines and summarizes additions/deletions/hunks cleanly without Android deps. */
object DiffDisplayFormatter {
    fun classifyLine(line: String): DiffLineKind = when {
        line.startsWith("diff --git ") ||
            line.startsWith("index ") ||
            line.startsWith("--- ") ||
            line.startsWith("+++ ") ||
            line.startsWith("new file mode ") ||
            line.startsWith("deleted file mode ") -> DiffLineKind.FILE_HEADER
        line.startsWith("@@ ") -> DiffLineKind.HUNK
        line.startsWith("+") -> DiffLineKind.ADD
        line.startsWith("-") -> DiffLineKind.DEL
        else -> DiffLineKind.CONTEXT
    }

    fun parseLines(diffText: String): List<ClassifiedDiffLine> {
        if (diffText.isEmpty()) return emptyList()
        return diffText.replace("\r\n", "\n").split('\n').map { line ->
            ClassifiedDiffLine(line, classifyLine(line))
        }
    }

    fun summarize(diffText: String): DiffLineStats {
        var additions = 0
        var deletions = 0
        var hunks = 0
        for (item in parseLines(diffText)) {
            when (item.kind) {
                DiffLineKind.ADD -> additions += 1
                DiffLineKind.DEL -> deletions += 1
                DiffLineKind.HUNK -> hunks += 1
                else -> {}
            }
        }
        return DiffLineStats(additions = additions, deletions = deletions, hunks = hunks)
    }
}
