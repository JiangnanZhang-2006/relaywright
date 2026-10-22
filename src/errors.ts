export const RELAY_ERROR_CODES = [
  'stale_ref',
  'occluded',
  'no_such_option',
  'select_failed',
  'timeout',
  'browser_not_ready',
  'bad_request',
  'bad_params',
  'param_unused',
  'skill_exists',
  'skill_not_found',
] as const;

export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number];

export class RelayError extends Error {
  readonly name = 'RelayError';

  constructor(
    readonly code: RelayErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function relayStatus(code: RelayErrorCode): 400 | 404 | 409 | 500 | 503 | 504 {
  switch (code) {
    case 'stale_ref':
    case 'occluded':
    case 'skill_exists':
      return 409;
    case 'no_such_option':
    case 'bad_request':
    case 'bad_params':
    case 'param_unused':
      return 400;
    case 'skill_not_found':
      return 404;
    case 'timeout':
      return 504;
    case 'browser_not_ready':
      return 503;
    default:
      return 500;
  }
}

export function browserDownloadingMessage(percent: number): string {
  return `Browser is downloading (${percent}%). Retry shortly, or run: relaywright browser install`;
}

export function staleTabRefMessage(ref: string): string {
  return `The active tab changed. Ref ${ref} is from a previous tab. Take a new snapshot.`;
}
