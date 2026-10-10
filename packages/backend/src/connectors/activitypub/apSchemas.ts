// Provenance: copied from OxyHQ/Mention packages/backend/src/connectors/activitypub/apSchemas.ts
// @ f5ad90c9bbf6cc9f7f9b93e1378c4b011031812b (origin/main). Trimmed to what an
// outbox reader validates: actor, note, Create/Announce and collections. The
// inbox activities (Follow, Like, Undo, …) are Mention's.

/**
 * Zod schemas for UNTRUSTED ActivityPub JSON. Every object is `.loose()` so a
 * server's extension fields never fail validation — only the fields read are
 * constrained — and every helper returns a boolean instead of throwing.
 */

import { z } from 'zod';

const apId = z.string().min(1);

/** ISO-8601 with or without offset; coerced to the original instant. */
const apPublished = z
  .string()
  .datetime({ offset: true, local: true })
  .pipe(z.coerce.date())
  .optional();

/** `type` is a string or, on some servers, an array of strings. */
const apType = z.union([z.string(), z.array(z.string())]);

const apLinkEntrySchema = z
  .object({
    type: apType.optional(),
    href: z.string().optional(),
    mediaType: z.string().optional(),
  })
  .loose();

const apUrl = z.union([
  z.string(),
  apLinkEntrySchema,
  z.array(z.union([z.string(), apLinkEntrySchema])),
]);

/** A Note attachment (media, `url` in any of its shapes) or an actor `PropertyValue`. */
const apAttachmentSchema = z
  .object({
    type: apType.optional(),
    mediaType: z.string().optional(),
    name: z.string().optional(),
    url: apUrl.optional(),
    value: z.string().optional(),
  })
  .loose();

const apTagSchema = z
  .object({ type: apType.optional(), name: z.string().optional(), href: z.string().optional() })
  .loose();

/** `icon` / `image`: a URL, an `Image` object, or an array of either. */
const apImageSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z
      .object({
        type: apType.optional(),
        mediaType: z.string().optional(),
        url: apUrl.optional(),
        href: z.string().optional(),
      })
      .loose(),
    z.array(apImageSchema),
  ]),
);

const apAddressing = z.union([z.string(), z.array(z.string())]).optional();
const apActorRef = z.union([z.string(), apLinkEntrySchema]).optional();

/** A content object: Note, Article, Question or Page. */
const apNoteSchema = z
  .object({
    id: apId,
    type: apType,
    attributedTo: apActorRef,
    content: z.string().optional(),
    contentMap: z.record(z.string(), z.string()).optional(),
    name: z.string().optional(),
    summary: z.string().nullable().optional(),
    published: apPublished,
    updated: apPublished,
    inReplyTo: z.union([z.string(), apLinkEntrySchema]).nullable().optional(),
    url: apUrl.optional(),
    sensitive: z.boolean().optional(),
    language: z.string().optional(),
    to: apAddressing,
    cc: apAddressing,
    tag: z.array(apTagSchema).optional(),
    attachment: z.array(apAttachmentSchema).optional(),
  })
  .loose();

const apActorSchema = z
  .object({
    id: apId,
    type: apType.optional(),
    inbox: z.string(),
    outbox: z.string().optional(),
    followers: z.string().optional(),
    following: z.string().optional(),
    preferredUsername: z.string().optional(),
    name: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    url: apUrl.optional(),
    icon: apImageSchema.optional(),
    image: apImageSchema.optional(),
    attachment: z.array(apAttachmentSchema).optional(),
    alsoKnownAs: z.array(z.string()).optional(),
    published: apPublished,
  })
  .loose();

/** The outbox activities an outbox reader maps: `Create` (a post) and `Announce` (a boost). */
const apOutboxActivitySchema = z.union([
  z
    .object({
      id: apId,
      type: z.literal('Create'),
      actor: apActorRef,
      object: z.union([z.string(), apNoteSchema]),
      published: apPublished,
      to: apAddressing,
      cc: apAddressing,
    })
    .loose(),
  z
    .object({
      id: apId,
      type: z.literal('Announce'),
      actor: apActorRef,
      object: z.union([
        z.string(),
        z.object({ id: apId.optional(), type: apType.optional() }).loose(),
      ]),
      published: apPublished,
      to: apAddressing,
      cc: apAddressing,
    })
    .loose(),
]);

const apLink = z.union([z.string(), apLinkEntrySchema]).optional();

const apOrderedCollectionPageSchema = z
  .object({
    id: z.string().optional(),
    type: apType.optional(),
    totalItems: z.number().optional(),
    orderedItems: z.array(z.unknown()).optional(),
    items: z.array(z.unknown()).optional(),
    next: apLink,
    prev: apLink,
    partOf: z.string().optional(),
  })
  .loose();

const apOrderedCollectionSchema = z
  .object({
    id: z.string().optional(),
    type: apType.optional(),
    totalItems: z.number().optional(),
    orderedItems: z.array(z.unknown()).optional(),
    items: z.array(z.unknown()).optional(),
    first: z.union([z.string(), apOrderedCollectionPageSchema, apLinkEntrySchema]).optional(),
    next: apLink,
    last: apLink,
  })
  .loose();

export const isApActor = (raw: unknown): boolean => apActorSchema.safeParse(raw).success;
export const isApNote = (raw: unknown): boolean => apNoteSchema.safeParse(raw).success;
export const isApOutboxActivity = (raw: unknown): boolean =>
  apOutboxActivitySchema.safeParse(raw).success;
export const isApCollection = (raw: unknown): boolean =>
  apOrderedCollectionSchema.safeParse(raw).success;
export const isApCollectionPage = (raw: unknown): boolean =>
  apOrderedCollectionPageSchema.safeParse(raw).success;
