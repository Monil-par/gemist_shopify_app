import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redisCommand } from "./redis.server";

const CACHE_TTL_SECONDS = 48 * 60 * 60;
const cacheDir = join(process.cwd(), ".cache", "gemist");
const memory = new Map<string, { expiresAt: number; value: unknown }>();

function filePath(key: string) {
  return join(cacheDir, `${key.replace(/[^a-z0-9:_-]+/gi, "-")}.json`);
}

function readMemory<T>(key: string): T | undefined {
  const entry = memory.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    memory.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function writeMemory(key: string, value: unknown, ttlSeconds: number) {
  memory.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

async function readFileCache<T>(key: string): Promise<T | undefined> {
  try {
    const raw = await readFile(filePath(key), "utf8");
    const parsed = JSON.parse(raw) as { expiresAt?: number; value?: T };
    if (!parsed?.expiresAt || parsed.expiresAt <= Date.now()) return undefined;
    writeMemory(key, parsed.value, Math.ceil((parsed.expiresAt - Date.now()) / 1000));
    return parsed.value;
  } catch {
    return undefined;
  }
}

async function writeFileCache(key: string, value: unknown, ttlSeconds: number) {
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      filePath(key),
      JSON.stringify({
        expiresAt: Date.now() + ttlSeconds * 1000,
        value,
      }),
    );
  } catch {
    /* disk cache is optional */
  }
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const local = readMemory<T>(key);
  if (local !== undefined) return local;

  const fromRedis = await redisCommand(async (redis) => {
    const raw = await redis.get(key);
    if (!raw) return undefined;
    return JSON.parse(raw) as T;
  });
  if (fromRedis !== undefined) {
    writeMemory(key, fromRedis, CACHE_TTL_SECONDS);
    return fromRedis;
  }

  return readFileCache<T>(key);
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number = CACHE_TTL_SECONDS,
): Promise<void> {
  writeMemory(key, value, ttlSeconds);
  void writeFileCache(key, value, ttlSeconds);
  await redisCommand(async (redis) => {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
    return true;
  });
}

export async function cacheDelete(key: string): Promise<void> {
  memory.delete(key);
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(filePath(key));
  } catch {
    /* file may not exist */
  }
  await redisCommand(async (redis) => {
    await redis.del(key);
    return true;
  });
}

export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const value = await load();
  await cacheSet(key, value, ttlSeconds);
  return value;
}

export { CACHE_TTL_SECONDS };
