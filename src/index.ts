import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import app from './http.js';
import { handleMcpRequest } from './mcp.js';
import { loadAllWorkspaces, loadAllSavedTemplates, loadAllSystemPromptTemplates, redisEnabled } from './persistence.js';
import { hydrateWorkspaces, hydrateGlobalTemplates, hydrateSystemPromptTemplates } from './state.js';

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as ArrayBuffer));
  }
  return Buffer.concat(chunks);
}

function isMcpPath(url: string): boolean {
  return url === '/mcp' || url.startsWith('/mcp?') || url.startsWith('/mcp/');
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? '/';
  const bodyBuf = await readBody(req);

  if (isMcpPath(url)) {
    let body: unknown;
    if (bodyBuf.length > 0) {
      try {
        body = JSON.parse(bodyBuf.toString());
      } catch {
        // non-JSON body; pass undefined
      }
    }
    await handleMcpRequest(req, res, body);
    return;
  }

  // Forward everything else to Hono via the Web Fetch API
  const host = req.headers.host ?? 'localhost';
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      headers[key] = Array.isArray(value) ? value.join(', ') : value;
    }
  }

  const canHaveBody = req.method !== 'GET' && req.method !== 'HEAD';
  const webReq = new Request(`http://${host}${url}`, {
    method: req.method ?? 'GET',
    headers,
    body: canHaveBody && bodyBuf.length > 0 ? bodyBuf.toString('utf8') : undefined,
  });

  try {
    const webRes = await app.fetch(webReq);
    const resBody = await webRes.arrayBuffer();
    const resHeaders: Record<string, string> = {};
    webRes.headers.forEach((value, key) => {
      resHeaders[key] = value;
    });
    res.writeHead(webRes.status, resHeaders);
    res.end(Buffer.from(resBody));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

const port = Number(process.env.PORT ?? 3000);

async function start() {
  if (redisEnabled) {
    const [workspaces, templates, systemPromptTemplates] = await Promise.all([
      loadAllWorkspaces(), loadAllSavedTemplates(), loadAllSystemPromptTemplates(),
    ]);
    hydrateWorkspaces(workspaces);
    if (templates.length > 0) hydrateGlobalTemplates(templates);
    if (systemPromptTemplates.length > 0) hydrateSystemPromptTemplates(systemPromptTemplates);
  }
  server.listen(port, () => {
    console.log(`overhang-mcp listening on :${port}`);
    console.log(`  MCP endpoint : http://localhost:${port}/mcp`);
    console.log(`  HTTP API     : http://localhost:${port}/prompts`);
    if (redisEnabled) console.log('  Persistence  : Upstash Redis');
  });
}

start();
