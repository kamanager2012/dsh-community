package org.dsh.community.android.ui

data class SlashCommandSpec(
    val name: String,
    val argsHint: String,
    val description: String,
)

sealed interface ParsedSlashCommand {
    data class NewSession(val title: String?) : ParsedSlashCommand
    data class RenameSession(val title: String) : ParsedSlashCommand
    data class ForkSession(val title: String?) : ParsedSlashCommand
    data class SearchSessions(val query: String) : ParsedSlashCommand
    data object LoadHistory : ParsedSlashCommand
    data object ListCommands : ParsedSlashCommand
    data object ListSkills : ParsedSlashCommand
    data object OpenModels : ParsedSlashCommand
    data object OpenSessions : ParsedSlashCommand
    data object ExportChat : ParsedSlashCommand
    data object StopTurn : ParsedSlashCommand
    data class SteerPrompt(val prompt: String) : ParsedSlashCommand
    data object Help : ParsedSlashCommand
    data class Error(val message: String) : ParsedSlashCommand
}

/**
 * Local consumer slash-command parser and autocomplete catalog for Android composer.
 * Unknown `/command` inputs return `null` so Host-side commands/skills can still execute.
 */
object SlashCommandHelper {
    val COMMANDS: List<SlashCommandSpec> = listOf(
        SlashCommandSpec("/new", "[title]", "Create and attach a new session"),
        SlashCommandSpec("/rename", "<title>", "Rename current session"),
        SlashCommandSpec("/fork", "[title]", "Fork current session into a new branch"),
        SlashCommandSpec("/history", "", "Load older transcript history page"),
        SlashCommandSpec("/search", "<query>", "Search messages across Host sessions"),
        SlashCommandSpec("/stop", "", "Abort active turn"),
        SlashCommandSpec("/steer", "<text>", "Send prompt in steer mode"),
        SlashCommandSpec("/model", "", "Select model and reasoning effort"),
        SlashCommandSpec("/sessions", "", "Browse and search sessions"),
        SlashCommandSpec("/commands", "", "List Host slash commands"),
        SlashCommandSpec("/skills", "", "List available Host skills"),
        SlashCommandSpec("/export", "", "Export session as Markdown"),
        SlashCommandSpec("/help", "", "Show mobile slash commands"),
    )

    fun matchSuggestions(rawInput: String): List<SlashCommandSpec> {
        val trimmed = rawInput.trimStart()
        if (!trimmed.startsWith("/")) return emptyList()
        if (trimmed.contains(' ') || trimmed.contains('\n')) return emptyList()
        val lower = trimmed.lowercase()
        return COMMANDS.filter { it.name.startsWith(lower) }
    }

    fun parse(rawInput: String): ParsedSlashCommand? {
        val trimmed = rawInput.trim()
        if (!trimmed.startsWith("/")) return null
        val firstSpace = trimmed.indexOfFirst { it.isWhitespace() }
        val cmd = (if (firstSpace < 0) trimmed else trimmed.substring(0, firstSpace)).lowercase()
        val arg = if (firstSpace < 0) "" else trimmed.substring(firstSpace + 1).trim()

        return when (cmd) {
            "/new" -> ParsedSlashCommand.NewSession(arg.ifEmpty { null })
            "/rename" -> {
                if (arg.isEmpty()) {
                    ParsedSlashCommand.Error("Usage: /rename <new title>")
                } else {
                    ParsedSlashCommand.RenameSession(arg)
                }
            }
            "/fork" -> ParsedSlashCommand.ForkSession(arg.ifEmpty { null })
            "/search" -> {
                if (arg.isEmpty()) {
                    ParsedSlashCommand.Error("Usage: /search <query>")
                } else {
                    ParsedSlashCommand.SearchSessions(arg)
                }
            }
            "/history" -> ParsedSlashCommand.LoadHistory
            "/commands" -> ParsedSlashCommand.ListCommands
            "/skills" -> ParsedSlashCommand.ListSkills
            "/stop" -> ParsedSlashCommand.StopTurn
            "/steer" -> {
                if (arg.isEmpty()) {
                    ParsedSlashCommand.Error("Usage: /steer <message>")
                } else {
                    ParsedSlashCommand.SteerPrompt(arg)
                }
            }
            "/model" -> ParsedSlashCommand.OpenModels
            "/sessions" -> ParsedSlashCommand.OpenSessions
            "/export" -> ParsedSlashCommand.ExportChat
            "/help" -> ParsedSlashCommand.Help
            else -> null
        }
    }

    fun formatHelpText(): String = buildString {
        appendLine("Mobile Slash Commands:")
        for (spec in COMMANDS) {
            val syntax = if (spec.argsHint.isBlank()) spec.name else "${spec.name} ${spec.argsHint}"
            appendLine("• $syntax — ${spec.description}")
        }
        append("Other /commands are executed via the Host session.")
    }
}
