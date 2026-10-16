import { describe, expect, test } from 'bun:test';
import { renderTelegramText } from '../connectors/telegram/textEntities';

const e = (type: string, text: string, href?: string) => ({
  type,
  text,
  ...(href ? { href } : {}),
});

describe('renderTelegramText', () => {
  test('formatting entities keep only their text', () => {
    const rendered = renderTelegramText({
      text_entities: [
        e('plain', 'Hi '),
        e('bold', 'bold'),
        e('plain', ' '),
        e('italic', 'it'),
        e('plain', ' '),
        e('spoiler', 'secret'),
        e('plain', ' '),
        e('code', 'x()'),
        e('plain', ' '),
        e('hashtag', '#tag'),
        e('plain', ' '),
        e('mention', '@someone'),
        e('plain', ' '),
        e('link', 'https://example.com'),
        e('plain', ' '),
        e('custom_emoji', '🔥'),
        e('plain', ' '),
        e('unknown_future_type', 'kept'),
      ],
    });
    expect(rendered).toEqual({
      text: 'Hi bold it secret x() #tag @someone https://example.com 🔥 kept',
      links: [],
    });
  });

  test('text_link: anchor stays, href goes to links, deduped', () => {
    const rendered = renderTelegramText({
      text_entities: [
        e('text_link', 'read this', 'https://example.com/a'),
        e('plain', ' and '),
        e('text_link', 'again', 'https://example.com/a'),
      ],
    });
    expect(rendered).toEqual({ text: 'read this and again', links: ['https://example.com/a'] });
  });

  test('text_link: an emoji-only anchor contributes no link', () => {
    const rendered = renderTelegramText({
      text_entities: [
        e('text_link', '👍🏽', 'https://emojipedia.org/thumbs-up'),
        e('text_link', ' ', 'https://example.com/space'),
        e('text_link', '1️⃣', 'https://emojipedia.org/keycap-1'),
      ],
    });
    expect(rendered).toEqual({ text: '👍🏽 1️⃣', links: [] });
  });

  test('text_link: an anchor that spells the URL becomes the URL', () => {
    const rendered = renderTelegramText({
      text_entities: [e('text_link', 'example.com/page', 'https://example.com/page/')],
    });
    expect(rendered).toEqual({ text: 'https://example.com/page/', links: [] });
  });

  test('text_link: past 10 links the href is written inline; non-http hrefs are dropped', () => {
    const entities = Array.from({ length: 11 }, (_, i) => [
      e('text_link', `l${i}`, `https://example.com/${i}`),
      e('plain', ' '),
    ]).flat();
    entities.push(e('text_link', 'app', 'tg://resolve?domain=x'));
    const rendered = renderTelegramText({ text_entities: entities });
    expect(rendered.links).toHaveLength(10);
    expect(rendered.text).toBe('l0 l1 l2 l3 l4 l5 l6 l7 l8 l9 l10 (https://example.com/10) app');
  });

  test('blockquote lines are prefixed and set on their own lines', () => {
    const rendered = renderTelegramText({
      text_entities: [e('plain', 'Said:'), e('blockquote', 'one\ntwo'), e('plain', 'after')],
    });
    expect(rendered.text).toBe('Said:\n> one\n> two\nafter');
  });

  test('legacy text: a string or a mixed array; \\r\\n normalised; end trimmed', () => {
    expect(renderTelegramText({ text: 'a\r\nb  \n' })).toEqual({ text: 'a\nb', links: [] });
    expect(
      renderTelegramText({
        text: ['see ', { type: 'text_link', text: 'here', href: 'https://example.com' }, '!'],
      }),
    ).toEqual({ text: 'see here!', links: ['https://example.com'] });
    expect(renderTelegramText({})).toEqual({ text: '', links: [] });
  });
});
