package org.dsh.community.android

import org.dsh.community.android.ui.RemoteLayoutBudget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteLayoutBudgetTest {
    @Test
    fun keepsUnboundedDrawersOnStandardPortraitViewportWithoutIme() {
        val density = 3.0f
        // 800dp tall portrait viewport, IME hidden
        val budget = RemoteLayoutBudget.compute(
            viewportHeightPx = (800 * density).toInt(),
            density = density,
            imeVisible = false,
            connectionVisible = true,
            logsVisible = false,
            pendingVisible = false,
        )
        assertEquals(Int.MAX_VALUE, budget.connectionPanelMaxPx)
        assertEquals(Int.MAX_VALUE, budget.pendingPanelMaxPx)
        assertEquals((170 * density + 0.5f).toInt(), budget.logsPanelHeightPx)
    }

    @Test
    fun capsDrawersOnImeConstrainedAndLandscapeViewportsSoComposerStaysVisible() {
        val density = 2.0f
        // 340dp left above soft keyboard with connection + logs open simultaneously
        val imeHeightPx = (340 * density).toInt()
        val budget = RemoteLayoutBudget.compute(
            viewportHeightPx = imeHeightPx,
            density = density,
            imeVisible = true,
            connectionVisible = true,
            logsVisible = true,
            pendingVisible = false,
        )
        assertTrue(budget.connectionPanelMaxPx < (200 * density).toInt())
        assertTrue(budget.logsPanelHeightPx < (150 * density).toInt())
        // Sum of capped drawers still leaves >= 140dp for header, session ribbon, timeline, and composer
        val combinedDrawersDp = (budget.connectionPanelMaxPx + budget.logsPanelHeightPx) / density
        assertTrue("combined=$combinedDrawersDp", combinedDrawersDp <= 210f)

        // 360dp landscape viewport even without IME triggers compact budget
        val landscapeBudget = RemoteLayoutBudget.compute(
            viewportHeightPx = (360 * density).toInt(),
            density = density,
            imeVisible = false,
            connectionVisible = true,
            logsVisible = false,
            pendingVisible = true,
        )
        assertTrue(landscapeBudget.connectionPanelMaxPx < Int.MAX_VALUE)
        assertTrue(landscapeBudget.pendingPanelMaxPx < Int.MAX_VALUE)
    }
}
