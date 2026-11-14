package org.dsh.community.android.ui

import org.dsh.community.android.protocol.SessionRef

enum class SessionFilter {
    ALL,
    RUNNING,
    ATTENTION,
    DIRTY,
}

data class SessionDashboardEntry(
    val session: SessionRef,
    val effectiveStatus: String?,
    val unreadCount: Int,
    val needsAttention: Boolean,
)

data class SessionDashboardGroup(
    val key: String,
    val label: String,
    val pathLabel: String?,
    val worktreeCount: Int,
    val hasDirtyWorktree: Boolean,
    val runningCount: Int,
    val attentionCount: Int,
    val entries: List<SessionDashboardEntry>,
)

data class SessionDashboardModel(
    val totalCount: Int,
    val runningCount: Int,
    val attentionCount: Int,
    val dirtyCount: Int,
    val groups: List<SessionDashboardGroup>,
)

/**
 * Pure-Kotlin aggregator, searcher, and commonRepoRoot/Git-worktree grouper for Android's
 * multi-session workspace dashboard.
 */
object SessionDashboardPlanner {
    private const val UNSCOPED_KEY = "__unscoped__"

    fun basename(rawPath: String): String {
        val trimmed = rawPath.trimEnd('/', '\\')
        if (trimmed.isEmpty()) return rawPath
        val lastSlash = maxOf(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
        return if (lastSlash >= 0 && lastSlash + 1 < trimmed.length) {
            trimmed.substring(lastSlash + 1)
        } else {
            trimmed
        }
    }

    fun matchesQuery(session: SessionRef, queryLower: String): Boolean {
        if (queryLower.isEmpty()) return true
        val ws = session.workspace
        return session.id.lowercase().contains(queryLower) ||
            (session.title?.lowercase()?.contains(queryLower) == true) ||
            (session.engine?.lowercase()?.contains(queryLower) == true) ||
            (session.model?.lowercase()?.contains(queryLower) == true) ||
            (session.cwd?.lowercase()?.contains(queryLower) == true) ||
            (ws?.branch?.lowercase()?.contains(queryLower) == true) ||
            (ws?.worktreeName?.lowercase()?.contains(queryLower) == true) ||
            (ws?.repoRoot?.lowercase()?.contains(queryLower) == true) ||
            (ws?.commonRepoRoot?.lowercase()?.contains(queryLower) == true)
    }

    fun build(
        sessions: List<SessionRef>,
        statusOverrides: Map<String, String> = emptyMap(),
        unreadCounts: Map<String, Int> = emptyMap(),
        filter: SessionFilter = SessionFilter.ALL,
        query: String = "",
    ): SessionDashboardModel {
        val queryLower = query.trim().lowercase()
        var runningTotal = 0
        var attentionTotal = 0
        var dirtyTotal = 0

        val allEntries = sessions.map { s ->
            val effectiveStatus = statusOverrides[s.id] ?: s.status
            val unread = (unreadCounts[s.id] ?: 0).coerceAtLeast(0)
            val pending = (s.pendingApprovals + s.pendingQuestions).coerceAtLeast(0)
            val needsAttention = pending > 0 || unread > 0
            if (effectiveStatus == "running") runningTotal += 1
            if (needsAttention) attentionTotal += 1
            if (s.workspace?.dirty == true) dirtyTotal += 1
            SessionDashboardEntry(
                session = s,
                effectiveStatus = effectiveStatus,
                unreadCount = unread,
                needsAttention = needsAttention,
            )
        }

        val filtered = allEntries.filter { entry ->
            val s = entry.session
            val passFilter = when (filter) {
                SessionFilter.ALL -> true
                SessionFilter.RUNNING -> entry.effectiveStatus == "running"
                SessionFilter.ATTENTION -> entry.needsAttention
                SessionFilter.DIRTY -> s.workspace?.dirty == true
            }
            passFilter && matchesQuery(s, queryLower)
        }

        val grouped = LinkedHashMap<String, MutableList<SessionDashboardEntry>>()
        for (entry in filtered) {
            val s = entry.session
            val ws = s.workspace
            val key = ws?.commonRepoRoot?.takeIf { it.isNotBlank() }
                ?: ws?.repoRoot?.takeIf { it.isNotBlank() }
                ?: s.cwd?.takeIf { it.isNotBlank() }
                ?: UNSCOPED_KEY
            grouped.getOrPut(key) { ArrayList() }.add(entry)
        }

        val groups = grouped.map { (key, entries) ->
            val sortedEntries = entries.sortedWith(
                compareByDescending<SessionDashboardEntry> { entryPriority(it) }
                    .thenByDescending { it.session.updatedAtMs ?: 0L },
            )
            val worktreeRoots = HashSet<String>()
            var dirty = false
            var running = 0
            var attention = 0
            var maxUpdated = 0L
            for (e in sortedEntries) {
                val root = e.session.workspace?.repoRoot ?: e.session.cwd
                if (!root.isNullOrBlank()) worktreeRoots.add(root)
                if (e.session.workspace?.dirty == true) dirty = true
                if (e.effectiveStatus == "running") running += 1
                if (e.needsAttention) attention += 1
                val u = e.session.updatedAtMs ?: 0L
                if (u > maxUpdated) maxUpdated = u
            }
            val pathLabel = if (key == UNSCOPED_KEY) null else key
            val label = if (pathLabel == null) "Unbound Workspace" else basename(pathLabel)
            Pair(
                maxUpdated,
                SessionDashboardGroup(
                    key = key,
                    label = label,
                    pathLabel = pathLabel,
                    worktreeCount = worktreeRoots.size,
                    hasDirtyWorktree = dirty,
                    runningCount = running,
                    attentionCount = attention,
                    entries = sortedEntries,
                ),
            )
        }.sortedWith(
            compareByDescending<Pair<Long, SessionDashboardGroup>> { (_, g) -> g.attentionCount > 0 }
                .thenByDescending { (_, g) -> g.runningCount > 0 }
                .thenByDescending { (_, g) -> g.hasDirtyWorktree }
                .thenByDescending { (maxUpdated, _) -> maxUpdated }
                .thenBy { (_, g) -> g.label.lowercase() },
        ).map { it.second }

        return SessionDashboardModel(
            totalCount = allEntries.size,
            runningCount = runningTotal,
            attentionCount = attentionTotal,
            dirtyCount = dirtyTotal,
            groups = groups,
        )
    }

    private fun entryPriority(e: SessionDashboardEntry): Int =
        (if (e.needsAttention) 4 else 0) +
            (if (e.effectiveStatus == "running") 2 else 0) +
            (if (e.session.workspace?.dirty == true) 1 else 0)
}
