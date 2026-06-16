import type { Workspace } from './types.js';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
export const redisEnabled = !!(REDIS_URL && REDIS_TOKEN);

const KEY_PREFIX = 'workspace:';
const TEMPLATES_KEY = 'templates';
const LEGACY_TEMPLATE_KEY = 'global-template';
const SYSTEM_PROMPT_TEMPLATES_KEY = 'system-prompt-templates';

async function redisCmd(cmd: unknown[]): Promise<unknown> {
  const r = await fetch(REDIS_URL!, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cmd),
  });
  const data = await r.json() as { result: unknown; error?: string };
  if (data.error) throw new Error(data.error);
  return data.result;
}

export function persistWorkspace(id: string, workspace: Workspace): void {
  if (!redisEnabled) return;
  redisCmd(['SET', `${KEY_PREFIX}${id}`, JSON.stringify(workspace)]).catch(() => {});
}

export function persistTemplates(templates: unknown[]): void {
  if (!redisEnabled) return;
  redisCmd(['SET', TEMPLATES_KEY, JSON.stringify(templates)]).catch(() => {});
}

export async function loadAllSavedTemplates(): Promise<unknown[]> {
  if (!redisEnabled) return [];
  try {
    const v = await redisCmd(['GET', TEMPLATES_KEY]) as string | null;
    if (v) return JSON.parse(v) as unknown[];
    // Backwards compat: old single-template key
    const old = await redisCmd(['GET', LEGACY_TEMPLATE_KEY]) as string | null;
    return old ? [JSON.parse(old)] : [];
  } catch {
    return [];
  }
}

export function persistSystemPromptTemplates(templates: unknown[]): void {
  if (!redisEnabled) return;
  redisCmd(['SET', SYSTEM_PROMPT_TEMPLATES_KEY, JSON.stringify(templates)]).catch(() => {});
}

export async function loadAllSystemPromptTemplates(): Promise<unknown[]> {
  if (!redisEnabled) return [];
  try {
    const v = await redisCmd(['GET', SYSTEM_PROMPT_TEMPLATES_KEY]) as string | null;
    return v ? JSON.parse(v) as unknown[] : [];
  } catch {
    return [];
  }
}

export function removeWorkspace(id: string): void {
  if (!redisEnabled) return;
  redisCmd(['DEL', `${KEY_PREFIX}${id}`]).catch(() => {});
}

export async function loadAllWorkspaces(): Promise<Workspace[]> {
  if (!redisEnabled) return [];
  try {
    const keys = (await redisCmd(['KEYS', `${KEY_PREFIX}*`])) as string[];
    if (!keys || keys.length === 0) return [];
    const values = (await redisCmd(['MGET', ...keys])) as (string | null)[];
    const workspaces: Workspace[] = [];
    for (const v of values) {
      if (!v) continue;
      try { workspaces.push(JSON.parse(v) as Workspace); } catch { /* skip corrupt */ }
    }
    console.log(`[redis] restored ${workspaces.length} workspace(s)`);
    return workspaces;
  } catch (e) {
    console.error('[redis] load failed:', e);
    return [];
  }
}
