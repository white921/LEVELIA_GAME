import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const activityDirectory = fileURLToPath(new URL('.', import.meta.url));
const defaultRoot = resolve(activityDirectory, '../activity-dist');
const documentRoot = resolve(process.env.ACTIVITY_DIST_DIR ?? defaultRoot);
const indexPath = resolve(documentRoot, 'index.html');

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function readPort(value) {
  if (value === undefined || value === '') {
    return 3000;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer from 1 to 65535: ${value}`);
  }

  return port;
}

function isInsideDocumentRoot(filePath) {
  return filePath === documentRoot || filePath.startsWith(`${documentRoot}${sep}`);
}

async function resolveFile(pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const requestedPath = resolve(documentRoot, `.${decodedPath}`);
  if (!isInsideDocumentRoot(requestedPath)) {
    return null;
  }

  try {
    const fileStats = await stat(requestedPath);
    if (fileStats.isFile()) {
      return requestedPath;
    }

    if (fileStats.isDirectory()) {
      const directoryIndex = resolve(requestedPath, 'index.html');
      if (isInsideDocumentRoot(directoryIndex) && (await stat(directoryIndex)).isFile()) {
        return directoryIndex;
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
      throw error;
    }
  }

  // Discord Activities are single-page applications. Unknown browser routes
  // should load the Activity shell instead of returning Railway's 404 page.
  return indexPath;
}

function writeText(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  response.end(body);
}

const port = readPort(process.env.PORT);

await access(indexPath);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://activity.local');

    if (url.pathname === '/health') {
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      writeText(response, 405, 'Method Not Allowed');
      return;
    }

    const filePath = await resolveFile(url.pathname);
    if (filePath === null) {
      writeText(response, 400, 'Bad Request');
      return;
    }

    const fileStats = await stat(filePath);
    const contentType = mimeTypes.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream';
    const isVersionedAsset = filePath.startsWith(resolve(documentRoot, 'assets') + sep);

    response.writeHead(200, {
      'Cache-Control': isVersionedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Content-Length': fileStats.size,
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
    });

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    createReadStream(filePath).pipe(response);
  } catch (error) {
    console.error('Activity request failed', error);
    if (!response.headersSent) {
      writeText(response, 500, 'Internal Server Error');
    } else {
      response.destroy();
    }
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`LEVELIA_GAME Activity listening on 0.0.0.0:${port}`);
});

function shutdown(signal) {
  console.log(`${signal} received; closing Activity server`);
  server.close(error => {
    if (error) {
      console.error('Activity server shutdown failed', error);
      process.exitCode = 1;
    }
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
