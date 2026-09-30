export class ApiError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export async function readJson(request, maxBytes = 8_192) {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      throw new ApiError(413, 'payload_too_large', 'Request body is too large');
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON');
  }
}

export function readBearerToken(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') {
    throw new ApiError(401, 'missing_access_token', 'Discord access token is required');
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match?.[1]) {
    throw new ApiError(401, 'invalid_access_token', 'Discord access token is invalid');
  }
  return match[1];
}

export function sendJson(response, statusCode, body) {
  const content = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(content),
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(content);
}

export function sendMethodNotAllowed(response, allowedMethods) {
  response.setHeader('Allow', allowedMethods.join(', '));
  sendJson(response, 405, {
    error: 'method_not_allowed',
    message: 'Method Not Allowed',
  });
}
