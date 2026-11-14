package org.dsh.community.android.ui

import kotlin.math.roundToInt

/** Computed drawer height budgets keeping timeline and composer reachable across screen sizes and IME states. */
data class RemoteLayoutBudget(
    val connectionPanelMaxPx: Int,
    val logsPanelHeightPx: Int,
    val pendingPanelMaxPx: Int,
) {
    companion object {
        private const val COMPACT_VIEWPORT_DP = 580f
        private const val DEFAULT_LOGS_DP = 170
        private const val RESERVED_CHROME_DP = 185

        fun compute(
            viewportHeightPx: Int,
            density: Float,
            imeVisible: Boolean,
            connectionVisible: Boolean,
            logsVisible: Boolean,
            pendingVisible: Boolean,
        ): RemoteLayoutBudget {
            val safeDensity = if (density > 0f) density else 1f
            fun dp(v: Int): Int = (v * safeDensity + 0.5f).toInt()

            val defaultLogsPx = dp(DEFAULT_LOGS_DP)
            if (viewportHeightPx <= 0) {
                return RemoteLayoutBudget(
                    connectionPanelMaxPx = Int.MAX_VALUE,
                    logsPanelHeightPx = defaultLogsPx,
                    pendingPanelMaxPx = Int.MAX_VALUE,
                )
            }

            val viewportDp = viewportHeightPx / safeDensity
            val compact = imeVisible || viewportDp < COMPACT_VIEWPORT_DP
            if (!compact) {
                return RemoteLayoutBudget(
                    connectionPanelMaxPx = Int.MAX_VALUE,
                    logsPanelHeightPx = defaultLogsPx,
                    pendingPanelMaxPx = Int.MAX_VALUE,
                )
            }

            val openDrawers = (if (connectionVisible) 1 else 0) +
                (if (logsVisible) 1 else 0) +
                (if (pendingVisible) 1 else 0)
            val availableDrawerBudgetPx = (viewportHeightPx - dp(RESERVED_CHROME_DP))
                .coerceAtLeast((viewportHeightPx * 0.35f).roundToInt())

            val connMax = when {
                openDrawers <= 1 -> minOf(dp(260), maxOf(dp(84), availableDrawerBudgetPx))
                else -> minOf(dp(220), maxOf(dp(72), (availableDrawerBudgetPx * 0.52f).roundToInt()))
            }
            val logsMax = when {
                openDrawers <= 1 -> minOf(defaultLogsPx, maxOf(dp(64), availableDrawerBudgetPx))
                else -> minOf(defaultLogsPx, maxOf(dp(60), (availableDrawerBudgetPx * 0.38f).roundToInt()))
            }
            val pendingMax = when {
                openDrawers <= 1 -> minOf(dp(240), maxOf(dp(84), availableDrawerBudgetPx))
                else -> minOf(dp(200), maxOf(dp(72), (availableDrawerBudgetPx * 0.45f).roundToInt()))
            }

            return RemoteLayoutBudget(
                connectionPanelMaxPx = connMax,
                logsPanelHeightPx = logsMax,
                pendingPanelMaxPx = pendingMax,
            )
        }
    }
}
