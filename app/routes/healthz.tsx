import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";

/**
 * Lightweight ops health check for staging/production load balancers.
 * Does not expose secrets or merchant data.
 */
export const loader = async (_args: LoaderFunctionArgs) => {
  let database = "ok";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = "error";
  }

  const ok = database === "ok";
  return new Response(
    JSON.stringify({
      ok,
      service: "gemist-shopify-app",
      env: process.env.NODE_ENV || "development",
      database,
      timestamp: new Date().toISOString(),
    }),
    {
      status: ok ? 200 : 503,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
};
