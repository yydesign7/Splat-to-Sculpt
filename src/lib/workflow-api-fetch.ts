'use client';

/** Header sent to API routes that write workflow files under the ephemeral session. */
export const EPHEMERAL_SESSION_HEADER = 'X-Ephemeral-Session-Id';

export function workflowApiFetch(
  ephemeralSessionId: string | null,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (ephemeralSessionId) {
    headers.set(EPHEMERAL_SESSION_HEADER, ephemeralSessionId);
  }
  return fetch(input, { ...init, headers });
}
