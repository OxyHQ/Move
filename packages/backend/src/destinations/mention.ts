/** Own import transport and account authority belong to Mention's SDK and Oxy core. */
import {
  mentionForOxyService,
  MentionServiceError,
  type MentionServiceIdentity,
  type MentionRequester,
} from '@oxy.so/mention-sdk/server';
import {
  MENTION_BATCH_MAX_ITEMS,
  MENTION_LOOKUP_MAX_IDS,
  MENTION_MAX_ALT,
  MENTION_MAX_CONTENT_WARNING,
  MENTION_MAX_LINKS,
  MENTION_MAX_MEDIA,
  MENTION_MAX_TEXT,
  MENTION_MAX_URL,
  mentionBatchRequestSchema,
  mentionBatchResponseSchema,
  mentionLookupResponseSchema,
  splitBySize,
  type MentionImportItem,
} from './mentionContract';
import {
  DestinationRateLimitedError,
  DestinationRejectedError,
  type ContentDestination,
  type DeliveryResult,
  type PreparedItem,
  type UndoResult,
} from './types';

export interface MentionDestinationDeps {
  baseUrl: string;
  /** The Oxy client whose service token authenticates Move. */
  oxy: MentionServiceIdentity;
}

/** When a source flagged a post sensitive without writing a warning. */
const DEFAULT_SENSITIVE_WARNING = 'Sensitive content';

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) && value.length <= MENTION_MAX_URL;
}

/**
 * Map a prepared item onto Mention's item schema, clamping to its limits so one
 * item can never make Mention refuse the whole batch with a 400:
 * - visibility: `unlisted` becomes `public` (Mention's own ActivityPub rule; it
 *   has no unlisted), `followers` becomes `followers_only`;
 * - a content warning longer than 500 is cut; alt text to 4000;
 * - media and links to 10 each, links to http(s) ≤ 2048;
 * - text to Mention's limit, which counts the links it appends;
 * - an article becomes `{ title, body }` with its body out of `text`.
 */
export function toMentionItem(
  item: PreparedItem,
): MentionImportItem & Required<Pick<MentionImportItem, 'media' | 'text'>> {
  const warning = item.contentWarning ?? (item.sensitive ? DEFAULT_SENSITIVE_WARNING : undefined);
  const contentWarning = warning?.trim().slice(0, MENTION_MAX_CONTENT_WARNING) || undefined;
  const links = (item.links ?? []).filter(isHttpUrl).slice(0, MENTION_MAX_LINKS);
  const textBudget = MENTION_MAX_TEXT - links.reduce((total, link) => total + link.length + 1, 0);
  const text = item.article ? (item.article.summary ?? '') : item.text;
  return {
    sourceId: item.sourceId,
    sourceUrl: item.sourceUrl,
    createdAt: item.createdAt,
    text: text.slice(0, textBudget),
    ...(contentWarning ? { contentWarning } : {}),
    ...(item.language ? { language: item.language } : {}),
    visibility: item.visibility === 'followers' ? 'followers_only' : 'public',
    ...(item.replyToSourceId ? { replyToSourceId: item.replyToSourceId } : {}),
    ...(item.quoteSourceId ? { quoteSourceId: item.quoteSourceId } : {}),
    media: item.media.slice(0, MENTION_MAX_MEDIA).map((media) => ({
      assetId: media.assetId,
      ...(media.alt ? { alt: media.alt.slice(0, MENTION_MAX_ALT) } : {}),
    })),
    ...(item.article ? { article: { title: item.article.title, body: item.text } } : {}),
    ...(links.length > 0 ? { links } : {}),
  };
}

export class MentionDestination implements ContentDestination {
  readonly name = 'mention' as const;
  readonly maxBatchSize = MENTION_BATCH_MAX_ITEMS;
  constructor(private readonly deps: MentionDestinationDeps) {}

  private async withClient<T>(
    accountId: string,
    requester: MentionRequester,
    run: (client: ReturnType<typeof mentionForOxyService>) => Promise<T>,
  ): Promise<T> {
    if (requester.accountId !== accountId)
      throw new DestinationRejectedError('Mention requester differs from migration account', 403);
    const client = mentionForOxyService(this.deps.oxy, { baseURL: this.deps.baseUrl, requester });
    try {
      return await run(client);
    } catch (error) {
      if (error instanceof MentionServiceError) {
        if (error.status === 429)
          throw new DestinationRateLimitedError(
            'Mention is rate limiting imports',
            error.retryAfterMs ?? 60_000,
          );
        if (error.status === 0 || error.status >= 500) throw error;
        throw new DestinationRejectedError('Mention refused the import', error.status);
      }
      throw error;
    } finally {
      client.dispose();
    }
  }

  /** Deliver in order, split into requests of ≤ 50 items and ≤ ~0.9 MB each. */
  async deliver(params: {
    oxyUserId: string;
    requester: MentionRequester;
    platform: 'mastodon' | 'bluesky';
    batchId: string;
    items: PreparedItem[];
  }): Promise<DeliveryResult[]> {
    const out: DeliveryResult[] = [];
    for (const chunk of splitBySize(params.items.map(toMentionItem))) {
      const payload = mentionBatchRequestSchema.parse({
        platform: params.platform,
        batchId: params.batchId,
        items: chunk,
      });
      const raw = await this.withClient(params.oxyUserId, params.requester, (client) =>
        client.importBatch(payload),
      );
      const parsed = mentionBatchResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new DestinationRejectedError(
          `Mention batch response did not match the contract: ${parsed.error.message}`,
          200,
        );
      }
      const bySource = new Map(parsed.data.results.map((result) => [result.sourceId, result]));
      // Every item sent gets an answer; one Mention forgot is a failure, not a success.
      for (const item of chunk) {
        const result = bySource.get(item.sourceId);
        if (!result) {
          out.push({ sourceId: item.sourceId, status: 'failed', error: 'missing-from-response' });
        } else if (
          (result.status === 'created' || result.status === 'existing') &&
          !result.postId
        ) {
          out.push({ sourceId: item.sourceId, status: 'failed', error: 'no-post-id' });
        } else {
          out.push({
            sourceId: item.sourceId,
            status: result.status,
            ...(result.postId ? { destinationId: result.postId } : {}),
            ...(result.error ? { error: result.error } : {}),
          });
        }
      }
    }
    return out;
  }

  async undo(params: {
    oxyUserId: string;
    batchId: string;
    requester: MentionRequester;
  }): Promise<UndoResult> {
    return this.withClient(params.oxyUserId, params.requester, (client) =>
      client.undoImportBatch(params.batchId),
    );
  }

  /** The source ids of this user + platform Mention already imported (any batch). */
  async lookupImported(params: {
    oxyUserId: string;
    requester: MentionRequester;
    platform: 'mastodon' | 'bluesky';
    sourceIds: string[];
  }): Promise<Set<string>> {
    const found = new Set<string>();
    const unique = [...new Set(params.sourceIds)];
    for (let start = 0; start < unique.length; start += MENTION_LOOKUP_MAX_IDS) {
      const raw = await this.withClient(params.oxyUserId, params.requester, (client) =>
        client.lookupImports({
          platform: params.platform,
          sourceIds: unique.slice(start, start + MENTION_LOOKUP_MAX_IDS),
        }),
      );
      for (const sourceId of Object.keys(mentionLookupResponseSchema.parse(raw).imported))
        found.add(sourceId);
    }
    return found;
  }
}
