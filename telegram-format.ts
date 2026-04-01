/**
 * Markdown → Telegram HTML converter.
 *
 * Converts Claude's markdown output to the limited HTML subset that Telegram
 * supports (bold, italic, strikethrough, code, pre, links, blockquote).
 * Headings become bold text, lists get bullet/number prefixes, tables become
 * preformatted blocks.
 *
 * Also provides HTML-aware chunking so long messages can be split without
 * breaking tags.
 */

import { marked, type Token, type Tokens } from 'marked';

// ─── HTML escaping ──────────────────────────────────────────────────────────

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape for use inside an HTML attribute value (already inside quotes). */
function escAttr(text: string): string {
  return esc(text).replace(/"/g, '&quot;');
}

// ─── Token renderer ─────────────────────────────────────────────────────────

function renderTokens(tokens: Token[]): string {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'paragraph':
        out += renderTokens(token.tokens!) + '\n\n';
        break;

      case 'strong':
        out += '<b>' + renderTokens(token.tokens!) + '</b>';
        break;

      case 'em':
        out += '<i>' + renderTokens(token.tokens!) + '</i>';
        break;

      case 'del':
        out += '<s>' + renderTokens(token.tokens!) + '</s>';
        break;

      case 'codespan':
        out += '<code>' + esc(token.text) + '</code>';
        break;

      case 'code': {
        const c = token as Tokens.Code;
        if (c.lang) {
          out += '<pre><code class="language-' + escAttr(c.lang) + '">' + esc(c.text) + '</code></pre>\n\n';
        } else {
          out += '<pre>' + esc(c.text) + '</pre>\n\n';
        }
        break;
      }

      case 'link': {
        const l = token as Tokens.Link;
        out += '<a href="' + escAttr(l.href) + '">' + renderTokens(l.tokens!) + '</a>';
        break;
      }

      case 'image': {
        // Telegram can't render inline images — show as a link
        const img = token as Tokens.Image;
        const alt = img.text || 'image';
        out += '<a href="' + escAttr(img.href) + '">' + esc(alt) + '</a>';
        break;
      }

      case 'heading':
        out += '<b>' + renderTokens(token.tokens!) + '</b>\n\n';
        break;

      case 'blockquote': {
        // Telegram's <blockquote> renders with a left bar.
        // Strip trailing paragraph newlines so the blockquote doesn't get extra whitespace.
        const inner = renderTokens((token as Tokens.Blockquote).tokens).replace(/\n+$/, '');
        out += '<blockquote>' + inner + '</blockquote>\n\n';
        break;
      }

      case 'list': {
        const list = token as Tokens.List;
        list.items.forEach((item, i) => {
          const prefix = list.ordered ? `${(list.start as number || 1) + i}. ` : '\u2022 ';
          // Render item content, trim trailing whitespace, collapse internal double-newlines
          const content = renderTokens(item.tokens).replace(/\n{2,}/g, '\n').trim();
          out += prefix + content + '\n';
        });
        out += '\n';
        break;
      }

      case 'table': {
        const tbl = token as Tokens.Table;
        out += renderTable(tbl);
        break;
      }

      case 'hr':
        out += '\u2500\u2500\u2500\n\n';
        break;

      case 'br':
        out += '\n';
        break;

      case 'text':
        if ('tokens' in token && token.tokens) {
          out += renderTokens(token.tokens);
        } else {
          out += esc(token.text);
        }
        break;

      case 'space':
        out += '\n';
        break;

      case 'html':
        // Escape raw HTML — Telegram only supports its own tag subset.
        // Claude rarely outputs raw HTML, but when it does (or when angle
        // brackets appear in text that marked misparses), we must escape.
        out += esc(token.text);
        break;

      default:
        // Fallback: try tokens, then text
        if ('tokens' in token && token.tokens) {
          out += renderTokens(token.tokens as Token[]);
        } else if ('text' in token) {
          out += esc(String((token as any).text));
        }
        break;
    }
  }
  return out;
}

// ─── Table renderer ─────────────────────────────────────────────────────────

/** Render a GFM table as a preformatted block with aligned columns. */
function renderTable(tbl: Tokens.Table): string {
  // Tables go inside <pre>, so we use plain text (no HTML tags in cells).
  const colCount = tbl.header.length;
  const headerPlain = tbl.header.map(cell => cellToPlain(cell.tokens));
  const bodyPlain = tbl.rows.map(row => row.map(cell => cellToPlain(cell.tokens)));

  // Calculate column widths from plain-text lengths
  const widths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    let max = headerPlain[c].length;
    for (const row of bodyPlain) {
      const len = (row[c] || '').length;
      if (len > max) max = len;
    }
    widths.push(max);
  }

  const pad = (text: string, width: number, align: string | null) => {
    const diff = width - text.length;
    if (diff <= 0) return text;
    if (align === 'right') return ' '.repeat(diff) + text;
    if (align === 'center') {
      const left = Math.floor(diff / 2);
      return ' '.repeat(left) + text + ' '.repeat(diff - left);
    }
    return text + ' '.repeat(diff);
  };

  const lines: string[] = [];
  // Header
  lines.push(headerPlain.map((h, c) => pad(h, widths[c], tbl.align[c])).join(' | '));
  // Separator
  lines.push(widths.map(w => '\u2500'.repeat(w)).join('\u2500+\u2500'));
  // Body
  for (const row of bodyPlain) {
    lines.push(row.map((cell, c) => pad(cell || '', widths[c], tbl.align[c])).join(' | '));
  }

  return '<pre>' + esc(lines.join('\n')) + '</pre>\n\n';
}

/** Extract plain text from tokens (for table cells inside <pre>). */
function cellToPlain(tokens: Token[]): string {
  let out = '';
  for (const t of tokens) {
    if ('tokens' in t && t.tokens) {
      out += cellToPlain(t.tokens as Token[]);
    } else if ('text' in t) {
      out += String((t as any).text);
    }
  }
  return out;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Convert markdown text to Telegram-compatible HTML.
 * Returns the original text unchanged if conversion fails.
 */
export function markdownToTelegramHtml(md: string): string {
  try {
    const tokens = marked.lexer(md, { gfm: true });
    const html = renderTokens(tokens);
    // Collapse runs of 3+ newlines to 2
    return html.replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    // If parsing fails, return escaped plain text so it's safe to send with parse_mode HTML
    return esc(md);
  }
}

// ─── HTML-aware chunking ────────────────────────────────────────────────────

/** Tags that Telegram supports (self-closing tags excluded). */
const TAG_RE = /<\/?(?:b|i|s|u|code|pre|a|blockquote|tg-spoiler|tg-emoji)[^>]*>/gi;

interface OpenTag {
  name: string;
  full: string; // The full opening tag string, e.g. '<a href="...">'
}

/**
 * Split Telegram HTML into chunks that fit within maxLen, ensuring every
 * chunk has properly closed/reopened tags.
 *
 * Strategy:
 * 1. Prefer splitting at double-newline (paragraph boundary)
 * 2. Fall back to single newline
 * 3. Fall back to maxLen hard cut (rare — only for very long unbroken text)
 * 4. At each split, close open tags and reopen in the next chunk
 */
export function splitHtmlChunks(html: string, maxLen: number): string[] {
  if (html.length <= maxLen) return [html];

  // Reserve headroom for closing tags appended at chunk boundaries.
  // Worst case: ~6 nested tags (e.g. blockquote>pre>code>b>i>a) ≈ 80 chars of closing tags.
  const TAG_HEADROOM = 100;
  const effectiveMax = maxLen - TAG_HEADROOM;

  const chunks: string[] = [];
  let remaining = html;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Find a split point: prefer double-newline, then single newline.
    // Use effectiveMax so closing tags don't push us past maxLen.
    let cut = remaining.lastIndexOf('\n\n', effectiveMax);
    if (cut <= 0) cut = remaining.lastIndexOf('\n', effectiveMax);
    if (cut <= 0) cut = effectiveMax;

    let chunk = remaining.slice(0, cut);
    remaining = remaining.slice(cut).replace(/^\n+/, '');

    // Track open tags in this chunk and close them
    const openTags = trackOpenTags(chunk);
    if (openTags.length > 0) {
      // Close tags in reverse order
      chunk += openTags.map(t => `</${t.name}>`).reverse().join('');
      // Reopen tags at the start of remaining text
      remaining = openTags.map(t => t.full).join('') + remaining;
    }

    chunks.push(chunk);
  }

  return chunks;
}

/**
 * Parse HTML to find which tags are still open at the end of the string.
 * Simple state machine — doesn't handle edge cases like tags inside
 * <pre>/<code> content, but good enough for Telegram's limited tag set.
 */
function trackOpenTags(html: string): OpenTag[] {
  const stack: OpenTag[] = [];
  let match: RegExpExecArray | null;
  let inPre = false;
  TAG_RE.lastIndex = 0;

  while ((match = TAG_RE.exec(html)) !== null) {
    const tag = match[0];
    const tagLower = tag.toLowerCase();

    if (tagLower === '<pre>' || tagLower.startsWith('<pre ')) {
      inPre = true;
      stack.push({ name: 'pre', full: tag });
      continue;
    }
    if (tagLower === '</pre>') {
      inPre = false;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === 'pre') {
          stack.splice(i, 1);
          break;
        }
      }
      continue;
    }

    // Skip tags inside <pre> blocks — they are content, not markup
    if (inPre) continue;

    if (tag.startsWith('</')) {
      // Closing tag — pop matching open tag
      const name = tag.slice(2, -1).toLowerCase();
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === name) {
          stack.splice(i, 1);
          break;
        }
      }
    } else {
      // Opening tag — extract tag name
      const nameMatch = tag.match(/^<([a-z-]+)/i);
      if (nameMatch) {
        stack.push({ name: nameMatch[1].toLowerCase(), full: tag });
      }
    }
  }

  return stack;
}
