/**
 * Move's ONE Oxy client. It verifies users' sessions (HTTP and Socket.IO),
 * keys the rate limiter, and is Move's own service identity for every call to
 * Oxy: linked accounts, federation, notifications, media imports, tasks.
 *
 * Move authenticates as its workload (ADR 0026/0049), never with an api key:
 * the shared AWS provider covers the ECS task role and a temporary local SSO
 * role. `serviceIdentity: 'when-anonymous'` sends a session-less read with that
 * service token instead of anonymously, so it is charged to Move rather than to
 * the fleet's NAT address; a checkout that can mint no token stays anonymous.
 *
 * A call AS a person goes through `oxy.withUser(req, …)`, never a second client.
 */

import { OxyServer } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';
import { config } from './config';

export const oxy = new OxyServer({
  baseURL: config.oxyApiUrl,
  serviceIdentity: 'when-anonymous',
  workloadCredentials: createAwsWorkloadCredentialProvider(),
});
