// Only same-site paths are accepted, so the post-login redirect cannot send users off-site.
export function safeReturnPath(locationState: unknown): string {
  const from = (locationState as { from?: unknown } | null)?.from;
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/';
}
