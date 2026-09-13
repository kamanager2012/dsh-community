import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { DshSession, DshMessage } from '../types/index.js';

export interface OfficialSessionRef {
  readonly id: string;
  readonly projectKey: string;
  readonly transcriptPath: string;
  readonly mtimeMs: number;
}

export interface DshSessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  model: string;
  filePath: string;
  isOfficial?: boolean;
}

const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Session ids are interpolated into filesystem paths; reject any value that
 * could escape the sessions directory (path separators, traversal segments,
 * NUL/control bytes) instead of letting it reach fs calls.
 */
export function sanitizeSessionId(sessionId: string): string {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError(`Invalid session id: must be a non-empty string`);
  }
  if (
    sessionId.includes('/') ||
    sessionId.includes('\\') ||
    sessionId.includes('..') ||
    sessionId.includes('\0')
  ) {
    throw new TypeError(`Invalid session id (path-unsafe characters rejected): "${sessionId}"`);
  }
  if (!SAFE_SESSION_ID_PATTERN.test(sessionId)) {
    throw new TypeError(
      `Invalid session id (must match ${SAFE_SESSION_ID_PATTERN.source}): "${sessionId}"`
    );
  }
  return sessionId;
}

/**
 * Session Store Adapter (Read-Safe & Segregated)
 * 
 * Safety Guarantee (P0):
 * 1. Official ~/.dsh/sessions is strictly READ-ONLY to avoid contaminating official runtime records.
 * 2. Suite-specific sessions are isolated in ~/.dsh/suite_sessions with atomic write protection.
 * 3. Supports reading and importing official session JSONL transcripts into unified DshSession view.
 */
export class DshSharedSessionStore {
  private officialSessionsDir: string;
  private suiteSessionsDir: string;

  constructor(customOfficialDir?: string, customSuiteDir?: string) {
    const dshHome = path.join(os.homedir(), '.dsh');
    this.officialSessionsDir = customOfficialDir || path.join(dshHome, 'sessions');
    this.suiteSessionsDir = customSuiteDir || path.join(dshHome, 'suite_sessions');

    if (!fs.existsSync(this.suiteSessionsDir)) {
      try {
        fs.mkdirSync(this.suiteSessionsDir, { recursive: true });
      } catch {
        // Ignore
      }
    }
  }

  public getSuiteDirectory(): string {
    return this.suiteSessionsDir;
  }

  public getOfficialDirectory(): string {
    return this.officialSessionsDir;
  }

  /**
   * Discovers official sessions from ~/.dsh/sessions in READ-ONLY mode.
   * Matches official layout: ~/.dsh/sessions/<project>/<sessionId>/session.jsonl(.zstd)
   */
  public listOfficialSessions(): OfficialSessionRef[] {
    if (!fs.existsSync(this.officialSessionsDir)) return [];
    const found: OfficialSessionRef[] = [];

    try {
      const projects = fs.readdirSync(this.officialSessionsDir, { withFileTypes: true });
      for (const proj of projects) {
        if (!proj.isDirectory()) continue;
        const projDir = path.join(this.officialSessionsDir, proj.name);
        const sessions = fs.readdirSync(projDir, { withFileTypes: true });
        for (const sess of sessions) {
          if (!sess.isDirectory()) continue;
          const sessDir = path.join(projDir, sess.name);
          const candidates = ['session.jsonl', 'session.jsonl.zstd'];
          for (const cand of candidates) {
            const transcript = path.join(sessDir, cand);
            if (fs.existsSync(transcript)) {
              found.push({
                id: sess.name,
                projectKey: proj.name,
                transcriptPath: transcript,
                mtimeMs: fs.statSync(transcript).mtimeMs,
              });
              break;
            }
          }
        }
      }
    } catch {
      // Ignore read errors
    }

    return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /**
   * List all Suite-managed sessions from ~/.dsh/suite_sessions
   */
  public listSessions(): DshSessionSummary[] {
    const summaries: DshSessionSummary[] = [];

    if (fs.existsSync(this.suiteSessionsDir)) {
      try {
        const files = fs.readdirSync(this.suiteSessionsDir);
        for (const file of files) {
          if (file.startsWith('.') || !file.endsWith('.json')) continue;
          const fullPath = path.join(this.suiteSessionsDir, file);
          try {
            const stats = fs.statSync(fullPath);
            const content = fs.readFileSync(fullPath, 'utf-8');
            const data = JSON.parse(content);
            summaries.push({
              id: data.id || path.basename(file, '.json'),
              title: data.title || `Session ${file.slice(0, 8)}`,
              updatedAt: data.updatedAt || stats.mtimeMs,
              messageCount: data.messages?.length || 0,
              model: data.model || 'deepseek-reasoner',
              filePath: fullPath,
              isOfficial: false,
            });
          } catch {
            // Ignore parse errors
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    // Append read-only official sessions as summaries
    const official = this.listOfficialSessions();
    for (const off of official) {
      summaries.push({
        id: off.id,
        title: `Official Session (${off.projectKey})`,
        updatedAt: off.mtimeMs,
        messageCount: 0,
        model: 'official-runtime',
        filePath: off.transcriptPath,
        isOfficial: true,
      });
    }

    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Parse an official JSONL transcript file into a clean DshSession view
   */
  public parseOfficialJsonlSession(ref: OfficialSessionRef): DshSession | null {
    if (!fs.existsSync(ref.transcriptPath) || !ref.transcriptPath.endsWith('.jsonl')) {
      return null;
    }

    try {
      const rawContent = fs.readFileSync(ref.transcriptPath, 'utf-8');
      const lines = rawContent.split('\n').filter((l) => l.trim().length > 0);
      const messages: DshMessage[] = [];

      let currentAssistantMessage: DshMessage | null = null;

      for (let i = 0; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i]);
          const eventType = entry.type || entry.event || '';
          const data = entry.data || entry;

          // 1. Direct message structures
          if (entry.role === 'user' || eventType === 'user/message') {
            if (currentAssistantMessage) {
              messages.push(currentAssistantMessage);
              currentAssistantMessage = null;
            }
            messages.push({
              id: entry.id || `msg_user_${i}`,
              role: 'user',
              content: String(data.content || data.text || entry.content || ''),
              timestamp: entry.time || entry.timestamp || Date.now(),
              status: 'complete',
            });
          } else if (entry.role === 'assistant' || eventType === 'assistant/message') {
            if (currentAssistantMessage) {
              messages.push(currentAssistantMessage);
              currentAssistantMessage = null;
            }
            messages.push({
              id: entry.id || `msg_asst_${i}`,
              role: 'assistant',
              content: String(data.content || data.text || entry.content || ''),
              reasoning: data.reasoning || entry.reasoning,
              timestamp: entry.time || entry.timestamp || Date.now(),
              status: 'complete',
            });
          } else if (eventType === 'assistant/chunk') {
            // Streaming chunk aggregation
            const chunk = data.chunk || data;
            const delta = String(chunk.delta || chunk.text || chunk.content || '');
            const isReasoning = chunk.type === 'reasoning' || chunk.blockType === 'reasoning';

            if (!currentAssistantMessage) {
              currentAssistantMessage = {
                id: `msg_asst_stream_${i}`,
                role: 'assistant',
                content: '',
                reasoning: '',
                timestamp: entry.time || Date.now(),
                status: 'complete',
              };
            }

            if (isReasoning) {
              currentAssistantMessage.reasoning = (currentAssistantMessage.reasoning || '') + delta;
            } else {
              currentAssistantMessage.content += delta;
            }
          }
        } catch {
          // Ignore individual malformed lines in JSONL
        }
      }

      if (currentAssistantMessage) {
        messages.push(currentAssistantMessage);
      }

      return {
        id: ref.id,
        title: `Official Session (${ref.projectKey})`,
        createdAt: ref.mtimeMs,
        updatedAt: ref.mtimeMs,
        workspacePath: process.cwd(),
        model: 'deepseek-reasoner',
        messages,
        metrics: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          tps: 0,
          contextLimit: 128000,
          contextUsagePercent: 0,
        },
      };
    } catch {
      return null;
    }
  }

  /**
   * Read full session by ID from suite sessions or official read-only storage
   */
  public readSession(sessionId: string): DshSession | null {
    // 1. First check suite sessions (sanitized: id is used as a filename)
    const safeId = sanitizeSessionId(sessionId);
    const suiteFilePath = path.join(this.suiteSessionsDir, `${safeId}.json`);
    if (fs.existsSync(suiteFilePath)) {
      try {
        return JSON.parse(fs.readFileSync(suiteFilePath, 'utf-8'));
      } catch {
        // Fall through to official search
      }
    }

    // 2. Search official sessions
    const officialRefs = this.listOfficialSessions();
    const matchingRef = officialRefs.find((r) => r.id === sessionId);
    if (matchingRef) {
      return this.parseOfficialJsonlSession(matchingRef);
    }

    return null;
  }

  /**
   * Save session to ~/.dsh/suite_sessions atomically (Never writes to official ~/.dsh/sessions)
   */
  public saveSession(session: DshSession): void {
    if (!fs.existsSync(this.suiteSessionsDir)) {
      fs.mkdirSync(this.suiteSessionsDir, { recursive: true });
    }
    const safeId = sanitizeSessionId(session.id);
    const targetFile = path.join(this.suiteSessionsDir, `${safeId}.json`);
    const tempFile = path.join(
      this.suiteSessionsDir,
      `.${safeId}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`
    );

    fs.writeFileSync(tempFile, JSON.stringify(session, null, 2), 'utf-8');
    fs.renameSync(tempFile, targetFile);
  }
}
