import type { DshSession } from '../types/index.js';

/**
 * Session Transcript Exporter
 * 
 * Formats multi-turn conversations, tool calls, and thought streams into
 * clean GitHub-flavored Markdown or structured JSON artifacts.
 */
export class DshTranscriptExporter {
  public static toMarkdown(session: DshSession): string {
    let md = `# 🤖 DeepSeek Harness Session Transcript\n\n`;
    md += `**Session ID**: \`${session.id}\`  \n`;
    md += `**Title**: ${session.title}  \n`;
    md += `**Model**: \`${session.model}\`  \n`;
    md += `**Workspace**: \`${session.workspacePath}\`  \n`;
    md += `**Created**: ${new Date(session.createdAt).toISOString().slice(0, 19).replace('T', ' ')} UTC  \n`;
    md += `**Total Tokens**: ${session.metrics.totalTokens.toLocaleString()} (Prompt: ${session.metrics.promptTokens.toLocaleString()}, Completion: ${session.metrics.completionTokens.toLocaleString()})  \n\n`;
    md += `---\n\n`;

    for (const msg of session.messages) {
      const timeStr = new Date(msg.timestamp).toISOString().slice(11, 19);
      if (msg.role === 'user') {
        md += `### 👤 User (${timeStr})\n\n${msg.content}\n\n`;
      } else if (msg.role === 'assistant') {
        md += `### 🧠 Assistant (${timeStr})\n\n`;
        const thought = msg.reasoning || msg.reasoningContent;
        if (thought) {
          md += `> <details>\n> <summary>💭 Thought Process</summary>\n>\n`;
          md += thought
            .split('\n')
            .map((line: string) => `> ${line}`)
            .join('\n');
          md += `\n> </details>\n\n`;
        }
        md += `${msg.content}\n\n`;
      } else if (msg.role === 'system') {
        md += `> ℹ️ **System (${timeStr})**: ${msg.content}\n\n`;
      }
    }

    return md.trim();
  }

  public static toJson(session: DshSession): string {
    return JSON.stringify(session, null, 2);
  }
}
