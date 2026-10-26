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
  'no_download',
  'pdf_unsupported',
  'human_required',
  'human_in_control',
  'version_conflict',
  'not_found',
  'state_missing',
  'extract_missing',
  'eval_disabled',
  'domain_not_allowed',
  'attach_timeout',
  'attach_failed',
] as const;

export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number];

export class RelayError extends Error {
  readonly name = 'RelayError';
  readonly details: Record<string, unknown>;

  constructor(
    readonly code: RelayErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.details = details ?? {};
  }
}

export function relayStatus(code: RelayErrorCode): 400 | 404 | 409 | 423 | 500 | 503 | 504 {
  switch (code) {
    case 'stale_ref':
    case 'occluded':
    case 'skill_exists':
    case 'no_download':
    case 'version_conflict':
      return 409;
    case 'no_such_option':
    case 'bad_request':
    case 'bad_params':
    case 'param_unused':
    case 'state_missing':
    case 'extract_missing':
    case 'eval_disabled':
    case 'domain_not_allowed':
    case 'attach_failed':
      return 400;
    case 'skill_not_found':
    case 'not_found':
      return 404;
    case 'timeout':
    case 'attach_timeout':
      return 504;
    case 'browser_not_ready':
      return 503;
    case 'human_required':
    case 'human_in_control':
      return 423;
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
