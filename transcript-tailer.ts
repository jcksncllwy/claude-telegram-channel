/**
 * JSONL transcript tailer.
 *
 * Watches ~/.claude/channels/telegram/active-session.json (written by a
 * SessionStart hook) and tails the session's JSONL transcript, forwarding
 * assistant thinking text to all allowlisted Telegram chats.
 */

import { readFileSync, statSync, openSync, readSync, closeSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { GrammyError, type Bot } from 'grammy'
import { markdownToTelegramHtml, splitHtmlChunks } from './telegram-format.js'
import type { Access } from './access.js'

const ACTIVE_SESSION_FILE = join(homedir(), '.claude', 'channels', 'telegram', 'active-session.json')
const TAIL_POLL_MS = 800        // how often to check JSONL for new lines
const SESSION_POLL_MS = 3000    // how often to check for active-session.json changes
const DEBOUNCE_MS = 1500        // batch rapid assistant text fragments
const MAX_MSG_LEN = 4000        // stay under Telegram's 4096 limit
const TAIL_CHUNK_SIZE = 64 * 1024  // read in 64KB chunks

type ActiveSession = {
  session_id: string
  transcript_path: string
  cwd: string
  model: string
  started_at: number
}

let currentSession: ActiveSession | null = null
let tailFd: number | null = null
let tailOffset = 0
let tailInterval: ReturnType<typeof setInterval> | null = null
let tailPartialLine = ''           // carry partial lines between reads
let pendingMessages: Array<{ prefix: string; text: string }> = []
let debounceTimer: ReturnType<typeof setTimeout> | null = null
// Map tool_use IDs to { name, sentMessageIds } for edit-on-result
const pendingToolCalls = new Map<string, {
  name: string
  description: string
  createdAt: number
  sentIds: Map<string, number>  // chat_id → telegram message_id
}>()

// Expire stale pendingToolCalls entries every 60s (e.g. tool_use with no result)
const TOOL_CALL_TTL_MS = 60_000
const toolCallCleanup = setInterval(() => {
  const cutoff = Date.now() - TOOL_CALL_TTL_MS
  for (const [id, entry] of pendingToolCalls) {
    if (entry.createdAt < cutoff) pendingToolCalls.delete(id)
  }
}, 60_000)
toolCallCleanup.unref()

// bot and loadAccess are injected by startTailer()
let _bot: Bot | null = null
let _loadAccess: (() => Access) | null = null

function readActiveSession(): ActiveSession | null {
  try {
    const raw = readFileSync(ACTIVE_SESSION_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed.session_id && parsed.transcript_path) return parsed as ActiveSession
  } catch {}
  return null
}

function stopTailing(): void {
  if (tailInterval) { clearInterval(tailInterval); tailInterval = null }
  if (tailFd !== null) { try { closeSync(tailFd) } catch {}; tailFd = null }
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
  flushRelay()
  tailOffset = 0
  tailPartialLine = ''
  currentSession = null
}

function queueRelay(prefix: string, text: string): void {
  pendingMessages.push({ prefix, text })
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(flushRelay, DEBOUNCE_MS)
}

const RELAY_SEND_DELAY_MS = 75  // throttle between sequential sends

function chunk(text: string, limit: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const cut = rest.lastIndexOf('\n', limit)
    const at = cut > limit / 2 ? cut : limit
    out.push(rest.slice(0, at))
    rest = rest.slice(at).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

async function flushRelay(): Promise<void> {
  if (pendingMessages.length === 0) return
  const messages = pendingMessages.splice(0)
  const access = _loadAccess!()

  for (const { prefix, text } of messages) {
    // Convert markdown to Telegram HTML
    const html = markdownToTelegramHtml(text)
    const chunks = splitHtmlChunks(`${prefix} ${html}`, MAX_MSG_LEN)
    for (const chat_id of access.allowFrom) {
      for (const c of chunks) {
        try {
          await _bot!.api.sendMessage(chat_id, c, { parse_mode: 'HTML' })
        } catch (err) {
          if (err instanceof GrammyError && err.error_code === 429) {
            // Telegram rate limit — wait the requested period and retry once
            const retryAfter = (err.parameters?.retry_after ?? 5) * 1000
            await new Promise(r => setTimeout(r, retryAfter))
            try {
              await _bot!.api.sendMessage(chat_id, c, { parse_mode: 'HTML' })
            } catch { /* give up on this chunk */ }
          } else if (err instanceof GrammyError && err.error_code === 400) {
            // HTML parse error — fall back to plain text
            const plainChunks = chunk(`${prefix} ${text}`, MAX_MSG_LEN)
            for (const pc of plainChunks) {
              try {
                await _bot!.api.sendMessage(chat_id, pc)
              } catch (e2) {
                if (e2 instanceof GrammyError && e2.error_code === 429) {
                  const retryAfter = (e2.parameters?.retry_after ?? 5) * 1000
                  await new Promise(r => setTimeout(r, retryAfter))
                  await _bot!.api.sendMessage(chat_id, pc).catch(() => {})
                }
              }
              await new Promise(r => setTimeout(r, RELAY_SEND_DELAY_MS))
            }
            continue  // already sent plain fallback, skip the delay below
          } else {
            process.stderr.write(`telegram channel: transcript relay failed: ${err}\n`)
          }
        }
        await new Promise(r => setTimeout(r, RELAY_SEND_DELAY_MS))
      }
    }
  }
}

// Send a tool call message immediately (not debounced) and track its
// Telegram message ID so we can edit it when the result arrives.
function sendToolCall(toolId: string, name: string, detail: string): void {
  const access = _loadAccess!()
  const text = `\u{1203C} ${name}${detail}`
  const entry = pendingToolCalls.get(toolId)
  if (!entry) return

  for (const chat_id of access.allowFrom) {
    void _bot!.api.sendMessage(chat_id, text).then(
      sent => { entry.sentIds.set(chat_id, sent.message_id) },
      err => { process.stderr.write(`telegram channel: tool call relay failed: ${err}\n`) },
    )
  }
}

// Edit the original tool call message to append the result.
function editToolResult(toolId: string, result: string, isError: boolean): void {
  const entry = pendingToolCalls.get(toolId)
  if (!entry) return
  pendingToolCalls.delete(toolId)

  const MAX_RESULT = 300
  const truncated = result.length > MAX_RESULT
    ? result.slice(0, MAX_RESULT) + `\u2026 (${result.length} chars)`
    : result
  const label = isError ? '\u274C' : '\u2192'
  const newText = `\u{1203C} ${entry.name}: ${entry.description}\n${label} ${truncated}`

  for (const [chat_id, msgId] of entry.sentIds) {
    void _bot!.api.editMessageText(chat_id, msgId, newText).catch(() => {
      // If edit fails (message too old, etc), send as new message
      void _bot!.api.sendMessage(chat_id, newText).catch(() => {})
    })
  }
}

function processTranscriptLine(line: string): void {
  try {
    const entry = JSON.parse(line)
    const msg = entry.message
    const content = msg?.content
    if (!Array.isArray(content)) return

    if (entry.type === 'assistant') {
      const stopReason = msg?.stop_reason

      for (const block of content) {
        if (block.type === 'text' && block.text?.trim()) {
          const prefix = stopReason === 'end_turn' ? '\u{12077}' : '\u{1202D}'
          queueRelay(prefix, block.text.trim())
        } else if (block.type === 'tool_use') {
          const name = block.name || 'unknown'
          const id = block.id || ''
          const input = block.input ?? {}
          // Build a concise tool description
          let detail = ''
          if (input.description) {
            detail = input.description
          } else if (input.command) {
            const cmd = String(input.command)
            detail = cmd.length > 80 ? cmd.slice(0, 80) + '\u2026' : cmd
          } else if (input.pattern) {
            detail = input.pattern
          } else if (input.file_path) {
            detail = input.file_path
          } else if (input.query) {
            detail = input.query
          }
          if (id) {
            pendingToolCalls.set(id, { name, description: detail, createdAt: Date.now(), sentIds: new Map() })
            sendToolCall(id, name, detail ? `: ${detail}` : '')
          }
        }
      }
    } else if (entry.type === 'user') {
      for (const block of content) {
        if (block.type !== 'tool_result') continue
        const toolId = block.tool_use_id || ''
        const isError = block.is_error === true
        const raw = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content)
        if (!raw?.trim()) continue
        editToolResult(toolId, raw.trim(), isError)
      }
    }
  } catch {
    // Not valid JSON — skip (partial line, etc.)
  }
}

function startTailing(session: ActiveSession): void {
  stopTailing()
  currentSession = session
  try {
    tailFd = openSync(session.transcript_path, 'r')
    // Seek to end — we only want NEW lines from this point forward
    const stat = statSync(session.transcript_path)
    tailOffset = stat.size
  } catch (err) {
    process.stderr.write(`telegram channel: can't open transcript: ${err}\n`)
    return
  }

  tailInterval = setInterval(() => {
    if (tailFd === null) return
    try {
      const stat = statSync(session.transcript_path)
      if (stat.size <= tailOffset) return

      // Read in fixed-size chunks to avoid large allocations
      const chunkBuf = Buffer.alloc(TAIL_CHUNK_SIZE)
      while (tailOffset < stat.size) {
        const toRead = Math.min(TAIL_CHUNK_SIZE, stat.size - tailOffset)
        const bytesRead = readSync(tailFd, chunkBuf, 0, toRead, tailOffset)
        if (bytesRead === 0) break
        tailOffset += bytesRead

        const text = tailPartialLine + chunkBuf.toString('utf8', 0, bytesRead)
        const lines = text.split('\n')
        // Last element may be incomplete — carry it to the next iteration
        tailPartialLine = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          processTranscriptLine(line)
        }
      }
    } catch (err) {
      process.stderr.write(`telegram channel: tail read error: ${err}\n`)
    }
  }, TAIL_POLL_MS)
  tailInterval.unref()
}

function checkActiveSession(): void {
  const session = readActiveSession()
  if (!session) {
    if (currentSession) stopTailing()
    return
  }
  // New or changed session?
  if (!currentSession || currentSession.session_id !== session.session_id) {
    process.stderr.write(`telegram channel: tailing transcript for session ${session.session_id}\n`)
    process.stderr.write(`telegram channel: transcript path: ${session.transcript_path}\n`)
    startTailing(session)
  }
}

let sessionCheckInterval: ReturnType<typeof setInterval> | null = null

/**
 * Start polling for active sessions and tailing transcripts.
 * Must be called after bot.start() resolves so bot is ready to send.
 */
export function startTailer(bot: Bot, loadAccess: () => Access): () => void {
  _bot = bot
  _loadAccess = loadAccess

  checkActiveSession()
  sessionCheckInterval = setInterval(checkActiveSession, SESSION_POLL_MS)
  sessionCheckInterval.unref()

  return () => {
    stopTailing()
    if (sessionCheckInterval) { clearInterval(sessionCheckInterval); sessionCheckInterval = null }
  }
}
