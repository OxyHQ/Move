/**
 * The shape of a Telegram Desktop JSON export ("Export chat history", format
 * "Machine-readable JSON"), as far as Move reads it.
 *
 * Every schema is permissive (`z.looseObject`): the export grows keys with each
 * Telegram Desktop release, and an unknown key must never fail an import. Only
 * the fields Move uses are typed. Field names are the export's own (snake case).
 */

import { z } from 'zod';

/** A text run: a plain string, or a `{ type, text }` entity (`text_link` adds `href`). */
export const telegramTextEntitySchema = z.looseObject({
  type: z.string(),
  text: z.string(),
  href: z.string().optional(),
});
export type TelegramTextEntity = z.infer<typeof telegramTextEntitySchema>;

/** The legacy `text` field: a string, or a mixed array of strings and entities. */
export const telegramTextSchema = z.union([
  z.string(),
  z.array(z.union([z.string(), telegramTextEntitySchema])),
]);

const unixSeconds = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]);

const pollSchema = z.looseObject({
  question: z.string().optional(),
  answers: z.array(z.looseObject({ text: z.string().optional() })).optional(),
});

const locationSchema = z.looseObject({
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

const contactSchema = z.looseObject({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  phone_number: z.string().optional(),
});

export const telegramMessageSchema = z.looseObject({
  id: z.number().int(),
  /** `message` or `service` (joins, pins, title changes…). */
  type: z.string(),
  /** UTC seconds. The sibling `date` is the EXPORTING machine's local time: never read it. */
  date_unixtime: unixSeconds.optional(),
  text: telegramTextSchema.optional(),
  text_entities: z.array(telegramTextEntitySchema).optional(),
  /** Present (possibly null) when the message was forwarded. */
  forwarded_from: z.string().nullable().optional(),
  reply_to_message_id: z.number().int().optional(),
  /** Set when the replied-to message lives in ANOTHER chat. */
  reply_to_peer_id: z.union([z.string(), z.number()]).optional(),
  /** Relative path inside the export, or a placeholder sentence in parentheses. */
  photo: z.string().optional(),
  file: z.string().optional(),
  media_type: z.string().optional(),
  mime_type: z.string().optional(),
  poll: pollSchema.optional(),
  location_information: locationSchema.optional(),
  place_name: z.string().optional(),
  address: z.string().optional(),
  contact_information: contactSchema.optional(),
});
export type TelegramMessage = z.infer<typeof telegramMessageSchema>;

/** The top level of a single-chat export; `messages` is streamed separately. */
export const telegramExportHeaderSchema = z.looseObject({
  name: z.string(),
  /** `public_channel`, `private_channel`, `public_supergroup`, `personal_chat`, … */
  type: z.string(),
  id: z.union([z.number().int(), z.string().regex(/^-?\d+$/)]),
});
export type TelegramExportHeader = z.infer<typeof telegramExportHeaderSchema>;
