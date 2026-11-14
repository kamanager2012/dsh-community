package org.dsh.community.android.ui

import android.text.method.LinkMovementMethod
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
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
    ) : RecyclerView.ViewHolder(view) {
        private val tvStreamingBadge: TextView = view.findViewById(R.id.tv_streaming_badge)
        private val tvThinkingToggle: TextView = view.findViewById(R.id.tv_thinking_toggle)
        private val tvThinkingBody: TextView = view.findViewById(R.id.tv_thinking_body)
        private val tvAssistantBody: TextView = view.findViewById(R.id.tv_assistant_body)

        fun bind(item: AssistantTurnItem) {
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
            val longClick = View.OnLongClickListener {
                onLongPressItem?.invoke(item)
                onLongPressItem != null
            }
            itemView.setOnLongClickListener(longClick)
            tvAssistantBody.setOnLongClickListener(longClick)

            if (item.thinkingText.isNotBlank()) {
                tvThinkingToggle.visibility = View.VISIBLE
                val arrow = if (item.isThinkingExpanded) "▾" else "▸"
                tvThinkingToggle.text = "$arrow Thinking (${item.thinkingText.length} chars)"
                tvThinkingToggle.setOnClickListener { onToggleThinking(item.stableId) }
                if (item.isThinkingExpanded) {
                    tvThinkingBody.visibility = View.VISIBLE
                    tvThinkingBody.text = item.thinkingText
                } else {
                    tvThinkingBody.visibility = View.GONE
                }
            } else {
                tvThinkingToggle.visibility = View.GONE
                tvThinkingBody.visibility = View.GONE
                tvThinkingToggle.setOnClickListener(null)
            }

            if (item.markdownText.isNotBlank()) {
                tvAssistantBody.visibility = View.VISIBLE
                tvAssistantBody.movementMethod = LinkMovementMethod.getInstance()
                tvAssistantBody.text = ChatMarkdownFormatter.format(item.markdownText)
            } else {
                tvAssistantBody.visibility = View.GONE
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
                    tvToolArgs.text = "Args:\n${item.argumentsText}"
                } else {
                    tvToolArgs.visibility = View.GONE
                }
                if (item.outputText.isNotBlank()) {
                    tvToolOutput.visibility = View.VISIBLE
                    tvToolOutput.text = "Output:\n${item.outputText}"
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
