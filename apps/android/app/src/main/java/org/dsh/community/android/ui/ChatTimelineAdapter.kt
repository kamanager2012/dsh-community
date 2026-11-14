package org.dsh.community.android.ui

import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.method.LinkMovementMethod
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import org.dsh.community.android.R

class ChatTimelineAdapter(
    private val onToggleThinking: (String) -> Unit,
    private val onToggleTool: (String) -> Unit,
    private val onLongPressItem: ((ChatTimelineItem) -> Unit)? = null,
    private val onCopyCode: ((language: String, code: String) -> Unit)? = null,
) : ListAdapter<ChatTimelineItem, RecyclerView.ViewHolder>(DIFF_CALLBACK) {

    override fun getItemViewType(position: Int): Int = when (getItem(position)) {
        is UserMessageItem -> VIEW_TYPE_USER
        is AssistantTurnItem -> VIEW_TYPE_ASSISTANT
        is ToolExecutionItem -> VIEW_TYPE_TOOL
        is SystemNoticeItem -> VIEW_TYPE_NOTICE
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        return when (viewType) {
            VIEW_TYPE_USER -> UserViewHolder(
                inflater.inflate(R.layout.item_chat_user, parent, false),
                onLongPressItem,
            )
            VIEW_TYPE_ASSISTANT -> AssistantViewHolder(
                inflater.inflate(R.layout.item_chat_assistant, parent, false),
                onToggleThinking,
                onLongPressItem,
                onCopyCode,
            )
            VIEW_TYPE_TOOL -> ToolViewHolder(
                inflater.inflate(R.layout.item_chat_tool, parent, false),
                onToggleTool,
                onLongPressItem,
            )
            else -> NoticeViewHolder(
                inflater.inflate(R.layout.item_chat_notice, parent, false),
                onLongPressItem,
            )
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        when (val item = getItem(position)) {
            is UserMessageItem -> (holder as UserViewHolder).bind(item)
            is AssistantTurnItem -> (holder as AssistantViewHolder).bind(item)
            is ToolExecutionItem -> (holder as ToolViewHolder).bind(item)
            is SystemNoticeItem -> (holder as NoticeViewHolder).bind(item)
        }
    }

    private class UserViewHolder(
        view: View,
        private val onLongPressItem: ((ChatTimelineItem) -> Unit)?,
    ) : RecyclerView.ViewHolder(view) {
        private val tvUserText: TextView = view.findViewById(R.id.tv_user_text)
        private val tvUserMeta: TextView = view.findViewById(R.id.tv_user_meta)

        fun bind(item: UserMessageItem) {
            if (item.text.isNotBlank()) {
                tvUserText.visibility = View.VISIBLE
                tvUserText.text = item.text
            } else {
                tvUserText.visibility = View.VISIBLE
                tvUserText.text = item.attachmentLabels.joinToString(", ") { "[Image: $it]" }.ifBlank { "(Image)" }
            }
            val metaParts = ArrayList<String>(2)
            if (item.attachmentLabels.isNotEmpty()) {
                metaParts.add(item.attachmentLabels.joinToString(", ") { "📷 $it" })
            }
            if (item.isOptimistic) {
                metaParts.add("Sending…")
            } else if (!item.sendError.isNullOrBlank()) {
                metaParts.add("Send failed: ${item.sendError}")
            }
            if (metaParts.isNotEmpty()) {
                tvUserMeta.visibility = View.VISIBLE
                tvUserMeta.text = metaParts.joinToString(" · ")
            } else {
                tvUserMeta.visibility = View.GONE
            }
            val longClick = View.OnLongClickListener {
                onLongPressItem?.invoke(item)
                onLongPressItem != null
            }
            itemView.setOnLongClickListener(longClick)
            tvUserText.setOnLongClickListener(longClick)
        }
    }

    private class AssistantViewHolder(
        view: View,
        private val onToggleThinking: (String) -> Unit,
        private val onLongPressItem: ((ChatTimelineItem) -> Unit)?,
        private val onCopyCode: ((language: String, code: String) -> Unit)?,
    ) : RecyclerView.ViewHolder(view) {
        private val tvStreamingBadge: TextView = view.findViewById(R.id.tv_streaming_badge)
        private val tvThinkingToggle: TextView = view.findViewById(R.id.tv_thinking_toggle)
        private val tvThinkingBody: TextView = view.findViewById(R.id.tv_thinking_body)
        private val llAssistantBlocks: LinearLayout = view.findViewById(R.id.ll_assistant_blocks)

        private var currentItem: AssistantTurnItem? = null
        private var lastRenderedMarkdown: String? = null
        private var lastRenderedStableId: String? = null

        private val itemLongClick = View.OnLongClickListener {
            val item = currentItem ?: return@OnLongClickListener false
            onLongPressItem?.invoke(item)
            onLongPressItem != null
        }

        private fun dp(v: Int): Int = (v * itemView.resources.displayMetrics.density + 0.5f).toInt()

        fun bind(item: AssistantTurnItem) {
            currentItem = item
            when {
                !item.isFinalized -> {
                    tvStreamingBadge.visibility = View.VISIBLE
                    tvStreamingBadge.text = "Streaming…"
                    tvStreamingBadge.setTextColor(ContextCompat.getColor(itemView.context, R.color.dsh_text_accent))
                }
                item.interrupted -> {
                    tvStreamingBadge.visibility = View.VISIBLE
                    tvStreamingBadge.text = "Interrupted"
                    tvStreamingBadge.setTextColor(ContextCompat.getColor(itemView.context, R.color.dsh_status_warn))
                }
                else -> {
                    tvStreamingBadge.visibility = View.GONE
                }
            }
            itemView.setOnLongClickListener(itemLongClick)

            if (item.thinkingText.isNotBlank()) {
                tvThinkingToggle.visibility = View.VISIBLE
                val arrow = if (item.isThinkingExpanded) "▾" else "▸"
                tvThinkingToggle.text = "$arrow Thinking (${item.thinkingText.length} chars)"
                tvThinkingToggle.setOnClickListener { onToggleThinking(item.stableId) }
                if (item.isThinkingExpanded) {
                    tvThinkingBody.visibility = View.VISIBLE
                    tvThinkingBody.movementMethod = LinkMovementMethod.getInstance()
                    tvThinkingBody.text = ChatMarkdownFormatter.formatThinking(item.thinkingText)
                } else {
                    tvThinkingBody.visibility = View.GONE
                }
            } else {
                tvThinkingToggle.visibility = View.GONE
                tvThinkingBody.visibility = View.GONE
                tvThinkingToggle.setOnClickListener(null)
            }

            if (item.markdownText.isNotBlank()) {
                llAssistantBlocks.visibility = View.VISIBLE
                if (lastRenderedStableId != item.stableId || lastRenderedMarkdown != item.markdownText) {
                    lastRenderedStableId = item.stableId
                    lastRenderedMarkdown = item.markdownText
                    renderAssistantBlocks(item.markdownText)
                }
            } else {
                llAssistantBlocks.visibility = View.GONE
                llAssistantBlocks.removeAllViews()
                lastRenderedStableId = null
                lastRenderedMarkdown = null
            }
        }

        private fun renderAssistantBlocks(markdown: String) {
            llAssistantBlocks.removeAllViews()
            val blocks = ChatMarkdownFormatter.parseRenderBlocks(markdown)
            val blockGap = dp(8)
            blocks.forEachIndexed { idx, block ->
                val blockView = when (block) {
                    is MarkdownRenderBlock.Prose -> createProseView(block)
                    is MarkdownRenderBlock.CodeFence -> createCodeCardView(block)
                    is MarkdownRenderBlock.Table -> createTableCardView(block)
                    MarkdownRenderBlock.HorizontalRule -> createDividerView()
                }
                val lp = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply {
                    if (idx > 0) topMargin = blockGap
                }
                llAssistantBlocks.addView(blockView, lp)
            }
        }

        private fun configureLinkTextView(tv: TextView) {
            tv.setLinkTextColor(ContextCompat.getColor(tv.context, R.color.dsh_text_accent))
            tv.setTextIsSelectable(true)
            tv.movementMethod = LinkMovementMethod.getInstance()
            tv.setOnLongClickListener(itemLongClick)
        }

        private fun createProseView(block: MarkdownRenderBlock.Prose): View {
            val ctx = itemView.context
            return TextView(ctx).apply {
                text = ChatMarkdownFormatter.formatProseLines(block.lines)
                textSize = 14f
                setTextColor(ContextCompat.getColor(ctx, R.color.dsh_text_primary))
                setLineSpacing(dp(2).toFloat(), 1f)
                configureLinkTextView(this)
            }
        }

        private fun createCodeCardView(block: MarkdownRenderBlock.CodeFence): View {
            val ctx = itemView.context
            val codeText = block.code.trimEnd('\n')
            val lineCount = if (codeText.isEmpty()) 0 else codeText.count { it == '\n' } + 1
            val langUpper = block.language.ifBlank { "text" }.uppercase()
            val streamingTag = if (!block.isClosed) " · streaming" else ""

            val card = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundResource(R.drawable.bg_code_surface)
                setOnLongClickListener(itemLongClick)
            }

            val header = LinearLayout(ctx).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(10), dp(6), dp(8), dp(6))
            }

            val langLabel = TextView(ctx).apply {
                text = "$langUpper · $lineCount ${if (lineCount == 1) "line" else "lines"}$streamingTag"
                textSize = 10.5f
                typeface = Typeface.MONOSPACE
                setTextColor(ContextCompat.getColor(ctx, R.color.dsh_text_secondary))
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            }

            val copyChip = TextView(ctx).apply {
                text = "Copy"
                textSize = 10.5f
                setTextColor(ContextCompat.getColor(ctx, R.color.dsh_text_accent))
                setBackgroundResource(R.drawable.bg_chip_neutral)
                setPadding(dp(9), dp(3), dp(9), dp(3))
                isClickable = true
                isFocusable = true
                setOnClickListener { view ->
                    onCopyCode?.invoke(block.language, codeText)
                    val tv = view as? TextView ?: return@setOnClickListener
                    tv.text = "Copied ✓"
                    tv.postDelayed({ tv.text = "Copy" }, 1400L)
                }
            }

            header.addView(langLabel)
            header.addView(copyChip)
            card.addView(header)

            val hairline = View(ctx).apply {
                setBackgroundColor(ContextCompat.getColor(ctx, R.color.dsh_border_subtle))
            }
            card.addView(hairline, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1)))

            val hScroll = HorizontalScrollView(ctx).apply {
                isFillViewport = true
                isHorizontalScrollBarEnabled = true
            }
            val codeTv = TextView(ctx).apply {
                text = CodeSyntaxHighlighter.highlight(codeText, block.language)
                typeface = Typeface.MONOSPACE
                textSize = 11.5f
                setTextColor(ContextCompat.getColor(ctx, R.color.dsh_text_primary))
                setPadding(dp(10), dp(8), dp(10), dp(10))
                setHorizontallyScrolling(true)
                setTextIsSelectable(true)
                setOnLongClickListener(itemLongClick)
            }
            hScroll.addView(
                codeTv,
                ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT),
            )
            card.addView(
                hScroll,
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT),
            )
            return card
        }

        private fun createTableCardView(block: MarkdownRenderBlock.Table): View {
            val ctx = itemView.context
            val card = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundResource(R.drawable.bg_code_surface)
                setOnLongClickListener(itemLongClick)
            }
            val hScroll = HorizontalScrollView(ctx).apply {
                isFillViewport = true
                isHorizontalScrollBarEnabled = true
            }
            val tableTv = TextView(ctx).apply {
                text = ChatMarkdownFormatter.formatTableText(block)
                typeface = Typeface.MONOSPACE
                textSize = 11.5f
                setTextColor(ContextCompat.getColor(ctx, R.color.dsh_text_primary))
                setPadding(dp(10), dp(8), dp(10), dp(8))
                setHorizontallyScrolling(true)
                configureLinkTextView(this)
            }
            hScroll.addView(
                tableTv,
                ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT),
            )
            card.addView(
                hScroll,
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT),
            )
            return card
        }

        private fun createDividerView(): View {
            val ctx = itemView.context
            return View(ctx).apply {
                setBackgroundColor(ContextCompat.getColor(ctx, R.color.dsh_border_subtle))
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1))
            }
        }
    }

    private class ToolViewHolder(
        view: View,
        private val onToggleTool: (String) -> Unit,
        private val onLongPressItem: ((ChatTimelineItem) -> Unit)?,
    ) : RecyclerView.ViewHolder(view) {
        private val llToolHeader: LinearLayout = view.findViewById(R.id.ll_tool_header)
        private val tvToolHeader: TextView = view.findViewById(R.id.tv_tool_header)
        private val tvToolStatus: TextView = view.findViewById(R.id.tv_tool_status)
        private val llToolDetails: LinearLayout = view.findViewById(R.id.ll_tool_details)
        private val tvToolArgs: TextView = view.findViewById(R.id.tv_tool_args)
        private val tvToolOutput: TextView = view.findViewById(R.id.tv_tool_output)

        private fun inferLanguage(text: String): String {
            val trimmed = text.trimStart()
            return when {
                trimmed.startsWith("diff --git ") ||
                    (trimmed.contains("\n@@ ") && (trimmed.contains("\n+++ ") || trimmed.contains("\n--- "))) -> "diff"
                trimmed.startsWith("{") || trimmed.startsWith("[") -> "json"
                else -> "bash"
            }
        }

        fun bind(item: ToolExecutionItem) {
            val ctx = itemView.context
            val arrow = if (item.isExpanded) "▾" else "▸"
            tvToolHeader.text = "$arrow Tool · ${item.toolName}"
            llToolHeader.setOnClickListener { onToggleTool(item.stableId) }
            val longClick = View.OnLongClickListener {
                onLongPressItem?.invoke(item)
                onLongPressItem != null
            }
            itemView.setOnLongClickListener(longClick)
            llToolHeader.setOnLongClickListener(longClick)

            val (statusLabel, colorRes) = when (item.status) {
                ToolExecutionStatus.RUNNING -> "Running" to R.color.dsh_status_warn
                ToolExecutionStatus.COMPLETED -> "Done" to R.color.dsh_status_active
                ToolExecutionStatus.ERROR -> "Error" to R.color.dsh_status_danger
            }
            tvToolStatus.text = statusLabel
            tvToolStatus.setTextColor(ContextCompat.getColor(ctx, colorRes))

            if (item.isExpanded && (item.argumentsText.isNotBlank() || item.outputText.isNotBlank())) {
                llToolDetails.visibility = View.VISIBLE
                if (item.argumentsText.isNotBlank()) {
                    tvToolArgs.visibility = View.VISIBLE
                    tvToolArgs.text = SpannableStringBuilder("Args:\n")
                        .append(CodeSyntaxHighlighter.highlight(item.argumentsText, inferLanguage(item.argumentsText)))
                } else {
                    tvToolArgs.visibility = View.GONE
                }
                if (item.outputText.isNotBlank()) {
                    tvToolOutput.visibility = View.VISIBLE
                    tvToolOutput.text = SpannableStringBuilder("Output:\n")
                        .append(CodeSyntaxHighlighter.highlight(item.outputText, inferLanguage(item.outputText)))
                } else {
                    tvToolOutput.visibility = View.GONE
                }
            } else {
                llToolDetails.visibility = View.GONE
            }
        }
    }

    private class NoticeViewHolder(
        view: View,
        private val onLongPressItem: ((ChatTimelineItem) -> Unit)?,
    ) : RecyclerView.ViewHolder(view) {
        private val tvNoticeText: TextView = view.findViewById(R.id.tv_notice_text)

        fun bind(item: SystemNoticeItem) {
            tvNoticeText.text = item.text
            val colorRes = if (item.isError) R.color.dsh_status_danger else R.color.dsh_text_secondary
            tvNoticeText.setTextColor(ContextCompat.getColor(itemView.context, colorRes))
            itemView.setOnLongClickListener {
                onLongPressItem?.invoke(item)
                onLongPressItem != null
            }
        }
    }

    companion object {
        private const val VIEW_TYPE_USER = 1
        private const val VIEW_TYPE_ASSISTANT = 2
        private const val VIEW_TYPE_TOOL = 3
        private const val VIEW_TYPE_NOTICE = 4

        private val DIFF_CALLBACK = object : DiffUtil.ItemCallback<ChatTimelineItem>() {
            override fun areItemsTheSame(oldItem: ChatTimelineItem, newItem: ChatTimelineItem): Boolean =
                oldItem.stableId == newItem.stableId

            override fun areContentsTheSame(oldItem: ChatTimelineItem, newItem: ChatTimelineItem): Boolean =
                oldItem == newItem
        }
    }
}
