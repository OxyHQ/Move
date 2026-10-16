/**
 * A Telegram message's text as Mention text: plain text plus the links whose
 * targets the text alone would lose.
 *
 * Telegram Desktop exports a message's text as a flat run of entities, each
 * `{ type, text }`, never nested. Formatting (bold, spoiler, code…) has no
 * Mention equivalent and is kept as its text. A `text_link` keeps its anchor in
 * the body and moves its `href` into `links`; see {@link renderTelegramText}.
 */

import type { TelegramMessage, TelegramTextEntity } from './exportSchema';

export const MAX_TELEGRAM_LINKS = 10;

export interface RenderedTelegramText {
  text: string;
  links: string[];
}

type TextSource = Pick<TelegramMessage, 'text' | 'text_entities'>;

/**
 * An anchor made only of emoji and whitespace. Telegram decorates emoji with
 * emojipedia links; those carry no meaning worth a link.
 */
const EMOJI_ONLY =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[0-9#*]️?⃣|[‍️⃣]|\s)*$/u;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function bareUrl(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function entitiesOf(message: TextSource): TelegramTextEntity[] {
  if (message.text_entities) return message.text_entities;
  const text = message.text;
  if (typeof text === 'string') return [{ type: 'plain', text }];
  if (!Array.isArray(text)) return [];
  return text.map((part) => (typeof part === 'string' ? { type: 'plain', text: part } : part));
}

/**
 * Rules:
 * - every entity contributes its `text` (custom emoji: its fallback emoji);
 * - `text_link`: the anchor stays; the `href` joins `links` (deduped, at most
 *   10; past that it is written inline as `anchor (href)`). An emoji/whitespace
 *   anchor adds no link. An anchor that IS the URL (minus scheme and trailing
 *   slash) is replaced by the full href. A non-http(s) href is dropped;
 * - `blockquote`: each line prefixed `> `, on lines of its own;
 * - no `text_entities`: the legacy `text` (string, or mixed array);
 * - `\r\n` becomes `\n`, and trailing whitespace is trimmed.
 */
export function renderTelegramText(message: TextSource): RenderedTelegramText {
  const links: string[] = [];
  let text = '';

  for (const entity of entitiesOf(message)) {
    const piece = (entity.text ?? '').replace(/\r\n?/g, '\n');
    switch (entity.type) {
      case 'text_link': {
        const href = entity.href?.trim() ?? '';
        if (!href || !isHttpUrl(href) || EMOJI_ONLY.test(piece)) {
          text += piece;
          break;
        }
        if (bareUrl(piece) === bareUrl(href)) {
          text += href;
          break;
        }
        text += piece;
        if (links.includes(href)) break;
        if (links.length < MAX_TELEGRAM_LINKS) links.push(href);
        else text += ` (${href})`;
        break;
      }
      case 'blockquote': {
        if (!piece) break;
        if (text && !text.endsWith('\n')) text += '\n';
        const lines = piece.replace(/\n+$/, '').split('\n');
        text += `${lines.map((line) => `> ${line}`).join('\n')}\n`;
        break;
      }
      default:
        text += piece;
    }
  }

  return { text: text.trimEnd(), links };
}
