package org.dsh.community.android

import org.dsh.community.android.protocol.DiffDisplayFormatter
import org.dsh.community.android.protocol.DiffLineKind
import org.junit.Assert.assertEquals
import org.junit.Test

class DiffDisplayFormatterTest {
    @Test
    fun classifiesHeadersHunksAdditionsDeletionsAndCountsStats() {
        val sample = listOf(
            "diff --git a/src/Main.kt b/src/Main.kt",
            "index 111111..222222 100644",
            "--- a/src/Main.kt",
            "+++ b/src/Main.kt",
            "@@ -10,3 +10,4 @@ fun main() {",
            " val unchanged = true",
            "-val oldVal = 1",
            "+val newVal = 2",
            "+val extra = 3",
            "",
        ).joinToString("\n")

        val parsed = DiffDisplayFormatter.parseLines(sample)
        assertEquals(DiffLineKind.FILE_HEADER, parsed[0].kind)
        assertEquals(DiffLineKind.FILE_HEADER, parsed[2].kind)
        assertEquals(DiffLineKind.FILE_HEADER, parsed[3].kind)
        assertEquals(DiffLineKind.HUNK, parsed[4].kind)
        assertEquals(DiffLineKind.CONTEXT, parsed[5].kind)
        assertEquals(DiffLineKind.DEL, parsed[6].kind)
        assertEquals(DiffLineKind.ADD, parsed[7].kind)
        assertEquals(DiffLineKind.ADD, parsed[8].kind)

        val stats = DiffDisplayFormatter.summarize(sample)
        assertEquals(2, stats.additions)
        assertEquals(1, stats.deletions)
        assertEquals(1, stats.hunks)
    }
}
