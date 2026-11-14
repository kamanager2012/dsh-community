package org.dsh.community.android.ui

import android.content.Context
import android.util.AttributeSet
import android.widget.ScrollView

/**
 * ScrollView that wraps content naturally on normal viewports and caps its height
 * with internal scrolling on compact, landscape, or IME-constrained screens.
 */
class ConstrainedScrollView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = android.R.attr.scrollViewStyle,
) : ScrollView(context, attrs, defStyleAttr) {
    var maxHeightPx: Int = Int.MAX_VALUE
        set(value) {
            if (field != value) {
                field = value
                requestLayout()
            }
        }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val cappedSpec = if (maxHeightPx in 1 until Int.MAX_VALUE) {
            val mode = MeasureSpec.getMode(heightMeasureSpec)
            val size = MeasureSpec.getSize(heightMeasureSpec)
            val limit = if (mode == MeasureSpec.UNSPECIFIED) maxHeightPx else minOf(size, maxHeightPx)
            MeasureSpec.makeMeasureSpec(limit, MeasureSpec.AT_MOST)
        } else {
            heightMeasureSpec
        }
        super.onMeasure(widthMeasureSpec, cappedSpec)
    }
}
