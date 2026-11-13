package org.dsh.community.android.service

import org.dsh.community.android.protocol.QuestionSpec

data class PendingApprovalItem(
    val callId: String,
    val summary: String,
    val sessionId: String? = null,
)

data class PendingQuestionItem(
    val questionId: String,
    val prompt: String,
    val sessionId: String? = null,
    val questions: List<QuestionSpec> = emptyList(),
)

/**
 * Thread-safe FIFO queue retaining overlapping tool approvals and questions so simultaneous
 * requests never overwrite an unresolved prior interaction in UI banners or notifications.
 */
class PendingInteractionQueue {
    private val approvals = ArrayList<PendingApprovalItem>()
    private val questions = ArrayList<PendingQuestionItem>()

    @Synchronized
    fun enqueueApproval(callId: String, summary: String, sessionId: String? = null): Boolean {
        if (callId.isBlank()) return false
        val idx = approvals.indexOfFirst { it.callId == callId }
        if (idx >= 0) {
            approvals[idx] = PendingApprovalItem(callId, summary, sessionId)
            return false
        }
        approvals.add(PendingApprovalItem(callId, summary, sessionId))
        return true
    }

    @Synchronized
    fun removeApproval(callId: String): PendingApprovalItem? {
        val idx = approvals.indexOfFirst { it.callId == callId }
        return if (idx >= 0) approvals.removeAt(idx) else null
    }

    @Synchronized
    fun peekApproval(): PendingApprovalItem? = approvals.firstOrNull()

    @Synchronized
    fun listApprovals(): List<PendingApprovalItem> = approvals.toList()

    @Synchronized
    fun enqueueQuestion(
        questionId: String,
        prompt: String,
        sessionId: String? = null,
        questions: List<QuestionSpec> = emptyList(),
    ): Boolean {
        if (questionId.isBlank()) return false
        val idx = questionsList().indexOfFirst { it.questionId == questionId }
        if (idx >= 0) {
            this.questions[idx] = PendingQuestionItem(questionId, prompt, sessionId, questions)
            return false
        }
        this.questions.add(PendingQuestionItem(questionId, prompt, sessionId, questions))
        return true
    }

    private fun questionsList(): List<PendingQuestionItem> = questions

    @Synchronized
    fun removeQuestion(questionId: String): PendingQuestionItem? {
        val idx = questions.indexOfFirst { it.questionId == questionId }
        return if (idx >= 0) questions.removeAt(idx) else null
    }

    @Synchronized
    fun peekQuestion(): PendingQuestionItem? = questions.firstOrNull()

    @Synchronized
    fun listQuestions(): List<PendingQuestionItem> = questions.toList()

    @Synchronized
    fun clearAll() {
        approvals.clear()
        questions.clear()
    }
}
