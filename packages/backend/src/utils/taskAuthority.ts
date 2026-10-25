import type { OxyServer } from '@oxy.so/core/server';

/** Ephemeral, sourced only from shared Oxy middleware; never persisted. */
export interface TaskSession {
  requesterToken: string;
  actorAccountId: string;
  effectiveAccountId: string;
}
export interface TaskAuthority {
  create(session: TaskSession, originId: string, kind?: 'goal' | 'request'): Promise<string>;
  revoke(taskId: string): Promise<void>;
}
export function taskAuthority(oxy: OxyServer): TaskAuthority {
  return {
    async create(session, originId, kind = 'goal') {
      const task = await oxy.agency.createTask(
        {
          origin: { kind, id: originId },
          actor: { type: 'requester', accountId: session.actorAccountId },
          effectiveAccountId: session.effectiveAccountId,
          expiresAt: new Date(
            Date.now() + (kind === 'request' ? 15 * 60_000 : 365 * 24 * 60 * 60_000),
          ).toISOString(),
        },
        { requesterToken: session.requesterToken },
      );
      if (
        task.requesterAccountId !== session.actorAccountId ||
        task.effectiveAccountId !== session.effectiveAccountId
      ) {
        await oxy.agency.revokeTask(task.id);
        throw new Error('Oxy returned a task for a different requester or account');
      }
      return task.id;
    },
    revoke: (taskId) => oxy.agency.revokeTask(taskId),
  };
}
