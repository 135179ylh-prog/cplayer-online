import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const port = Number(process.argv[2] || process.env.PW_PORT || 4173);
const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.woff2': 'font/woff2'
};

function resolveRequestPath(requestUrl) {
    const pathname = decodeURIComponent(new URL(requestUrl, 'http://127.0.0.1').pathname);
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = resolve(projectRoot, relativePath);
    const relativeToRoot = relative(projectRoot, filePath);
    if (relativeToRoot.startsWith('..' + sep) || relativeToRoot === '..' || relativeToRoot.includes(`..${sep}`)) {
        return null;
    }
    return { filePath, pathname };
}

const server = createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' });
        response.end();
        return;
    }

    let resolved;
    try {
        resolved = resolveRequestPath(request.url || '/');
    } catch (error) {
        response.writeHead(400);
        response.end('Bad request');
        return;
    }
    if (!resolved) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
    }

    try {
        const body = await fs.readFile(resolved.filePath);
        const headers = {
            'Cache-Control': 'no-store',
            'Content-Length': body.byteLength,
            'Content-Type': contentTypes[extname(resolved.filePath).toLowerCase()] || 'application/octet-stream'
        };
        if (resolved.pathname === '/tests/e2e/fixtures/sw-old.js') {
            headers['Service-Worker-Allowed'] = '/';
        }
        response.writeHead(200, headers);
        if (request.method === 'HEAD') response.end();
        else response.end(body);
    } catch (error) {
        response.writeHead(error.code === 'ENOENT' ? 404 : 500);
        response.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
    }
});

server.listen(port, '127.0.0.1', () => {
    console.log(`test server listening on http://127.0.0.1:${port}`);
});
