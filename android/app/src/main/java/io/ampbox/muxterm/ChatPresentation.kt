package io.ampbox.muxterm

import org.json.JSONArray
import org.json.JSONObject

/** Android's projection of the shared SDK chat presentation vocabulary. */
internal enum class ChatBlockKind { USER, STEER, ASSISTANT, COMMENTARY, ACTIVITY, QUESTION, STATUS, ERROR }

internal data class ChatAttachment(val id: String, val name: String, val kind: String)
internal data class ChatQuestion(val id: String, val header: String, val prompt: String,
    val options: List<String>, val isOther: Boolean, val isSecret: Boolean)

internal data class ChatBlock(
    val kind: ChatBlockKind,
    val text: String,
    val turn: Int,
    val id: String = "",
    val name: String = "",
    val at: String = "",
    val done: Boolean = false,
    val failed: Boolean = false,
    val attachments: List<ChatAttachment> = emptyList(),
    val durationSeconds: Long? = null,
    val questions: List<ChatQuestion> = emptyList(),
    val questionSource: String = "",
)

internal data class ChatTranscript(val blocks: List<ChatBlock>, val running: Boolean, val uncertain: Boolean)

internal object ChatPresentation {
    fun fromEvents(events: JSONArray): ChatTranscript {
        val blocks = mutableListOf<ChatBlock>()
        var turn = 0
        var running = false
        var uncertain = false
        var turnStartedAt = ""
        for (index in 0 until events.length()) {
            val event = events.optJSONObject(index) ?: continue
            val type = event.optString("type")
            val text = event.optString("text")
            val at = event.optString("at")
            when (type) {
                "turn.started" -> {
                    running = true
                    if (turnStartedAt.isBlank()) turnStartedAt = at
                    if (blocks.none { it.turn == turn && it.kind == ChatBlockKind.ACTIVITY })
                        blocks += ChatBlock(ChatBlockKind.ACTIVITY, "", turn, name = "Working", at = at)
                }
                "input.accepted" -> {
                    val origin = event.optJSONObject("origin")?.optString("type").orEmpty()
                    if (origin == "operator-lane" || origin == "chat-message" || origin == "external-tool") {
                        if (text.isNotBlank()) blocks += ChatBlock(ChatBlockKind.ACTIVITY, text, turn,
                            name = event.optJSONObject("origin")?.optString("name").orEmpty().ifBlank { "Linked chat" }, at = at, done = true)
                    } else if (event.optString("source") != "voice") {
                        val kind = if (event.optString("kind") == "steer") ChatBlockKind.STEER else ChatBlockKind.USER
                        blocks += ChatBlock(kind, text, turn, id = event.optString("inputId"), at = at,
                            attachments = attachments(event.optJSONArray("attachments")))
                    }
                    running = true
                    uncertain = false
                }
                "voice.input.delta", "voice.output.delta", "assistant.delta", "commentary.delta" -> {
                    val kind = when (type) {
                        "voice.input.delta" -> ChatBlockKind.USER
                        "commentary.delta" -> ChatBlockKind.COMMENTARY
                        else -> ChatBlockKind.ASSISTANT
                    }
                    val last = blocks.lastOrNull()
                    val id = event.optString("itemId")
                    if (last != null && last.kind == kind && last.turn == turn && last.id == id && !last.done) {
                        blocks[blocks.lastIndex] = last.copy(text = last.text + text, at = at.ifBlank { last.at }, done = event.optBoolean("complete"))
                    } else if (text.isNotBlank()) {
                        blocks += ChatBlock(kind, text, turn, id = id, at = at, done = event.optBoolean("complete"))
                    }
                }
                "assistant.interim" -> {
                    val last = blocks.lastOrNull()
                    if (last?.kind == ChatBlockKind.ASSISTANT) blocks[blocks.lastIndex] = last.copy(kind = ChatBlockKind.COMMENTARY, done = true)
                }
                "work.activity", "tool.started", "tool.completed", "delegate.spawned", "delegate.completed", "operator.lane.status", "operator.lane.report" -> {
                    val id = event.optString("toolId").ifBlank { event.optString("childSessionId") }
                    val name = event.optString("name").ifBlank { event.optString("agent") }.ifBlank {
                        if (type.startsWith("delegate.")) "Delegated agent" else "Activity"
                    }
                    val done = type.endsWith("completed") || type == "operator.lane.report" || event.optString("kind") == "completed"
                    val row = ChatBlock(ChatBlockKind.ACTIVITY, text, turn,
                        id = id, name = name, at = at, done = done, failed = event.optBoolean("failed"))
                    val previous = blocks.indexOfLast { it.kind == ChatBlockKind.ACTIVITY && id.isNotBlank() && it.id == id && it.turn == turn }
                    if (previous >= 0) blocks[previous] = row else blocks += row
                }
                "question.requested", "question.suggested" -> {
                    val questions = event.optJSONObject("raw")?.optJSONArray("questions")
                    val prompts = buildList {
                        if (questions != null) for (questionIndex in 0 until questions.length()) questions.optJSONObject(questionIndex)?.let { item ->
                            val options = item.optJSONArray("options")
                            add(ChatQuestion(item.optString("id"), item.optString("header"), item.optString("question"),
                                buildList { if (options != null) for (optionIndex in 0 until options.length())
                                    options.optJSONObject(optionIndex)?.optString("label")?.let { add(it) } },
                                item.optBoolean("isOther"), item.optBoolean("isSecret")))
                        }
                    }
                    blocks += ChatBlock(ChatBlockKind.QUESTION, prompts.firstOrNull()?.prompt ?: "Agent asked a question", turn,
                        id = event.optString("itemId"), at = at, questions = prompts, questionSource = type)
                }
                "question.answered", "question.resolved" -> {
                    val id = event.optString("itemId")
                    val previous = blocks.indexOfLast { it.kind == ChatBlockKind.QUESTION && it.id == id }
                    if (previous >= 0) blocks[previous] = blocks[previous].copy(done = true)
                }
                "turn.continued" -> blocks.replaceAll { if (it.turn == turn && it.kind == ChatBlockKind.ASSISTANT) it.copy(kind = ChatBlockKind.COMMENTARY, done = true) else it }
                "turn.completed", "turn.cancelled" -> {
                    running = false
                    val duration = runCatching {
                        (java.time.Instant.parse(at).toEpochMilli() - java.time.Instant.parse(turnStartedAt).toEpochMilli()) / 1000
                    }.getOrNull()?.coerceAtLeast(0)
                    var assignedDuration = false
                    blocks.replaceAll { block ->
                        if (block.turn != turn || block.kind != ChatBlockKind.ACTIVITY) block
                        else if (!assignedDuration) {
                            assignedDuration = true
                            block.copy(done = true, durationSeconds = duration)
                        } else block.copy(done = true)
                    }
                    if (type == "turn.cancelled") blocks += ChatBlock(ChatBlockKind.STATUS, "Stopped by you · partial output kept", turn, at = at)
                    turn++
                    turnStartedAt = ""
                }
                "task.cancel.requested" -> blocks += ChatBlock(ChatBlockKind.STATUS, "Stopping…", turn, at = at)
                "session.uncertain", "error", "voice.session.error" -> {
                    blocks += ChatBlock(ChatBlockKind.ERROR, event.optString("message").ifBlank { "Session error" }, turn, at = at)
                    running = false
                    uncertain = type == "session.uncertain"
                    turn++
                    turnStartedAt = ""
                }
                "goal.progress" -> if (event.optString("goalState") in listOf("complete", "failed", "blocked")) {
                    blocks += ChatBlock(ChatBlockKind.STATUS,
                        "Goal ${event.optString("goalState")}: ${event.optString("goalSummary").ifBlank { event.optString("goalReason") }}", turn, at = at)
                }
            }
        }
        return ChatTranscript(blocks, running, uncertain)
    }

    private fun attachments(items: JSONArray?): List<ChatAttachment> = buildList {
        if (items == null) return@buildList
        for (index in 0 until items.length()) items.optJSONObject(index)?.let {
            add(ChatAttachment(it.optString("id"), it.optString("name"), it.optString("kind")))
        }
    }
}
