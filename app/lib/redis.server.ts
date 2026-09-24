import Redis from "ioredis";

let client: Redis | null = null;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getRedis(): Promise<Redis | null> {
  const url = (process.env.REDIS_URL || "").trim();
  if (!url) return null;

  if (client?.status === "ready") return client;
  if (client && (client.status === "end" || client.status === "close")) {
    client = null;
  }

  try {
    if (!client) {
      client = new Redis(url, {
        maxRetriesPerRequest: 1,
        connectTimeout: 800,
        commandTimeout: 800,
        lazyConnect: true,
        enableOfflineQueue: false,
        retryStrategy(times) {
          if (times > 2) return null;
          return Math.min(times * 200, 800);
        },
      });
      client.on("error", (error) => {
        console.warn("[gemist redis]", error.message);
      });
    }

    if (client.status === "wait") {
      await Promise.race([
        client.connect(),
        wait(800).then(() => {
          throw new Error("Redis connect timeout");
        }),
      ]);
    }

    return client.status === "ready" ? client : null;
  } catch (error) {
    console.warn(
      "[gemist redis] unavailable",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export async function redisCommand<T>(
  run: (redis: Redis) => Promise<T>,
): Promise<T | undefined> {
  const redis = await getRedis();
  if (!redis) return undefined;
  try {
    return await Promise.race([
      run(redis),
      wait(800).then(() => {
        throw new Error("Redis command timeout");
      }),
    ]);
  } catch {
    return undefined;
  }
}
