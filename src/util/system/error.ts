// Avoid logging raw SDK errors: request details can contain credentials.
export function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String(error.code);
    if (/^[A-Za-z0-9_]+$/.test(code)) return code;
  }
  return 'UNKNOWN_ERROR';
}
