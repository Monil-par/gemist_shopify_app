import type { ActionFunctionArgs } from "react-router";
import { readAdminRequest } from "../lib/admin-link.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const body = await readAdminRequest<Record<string, unknown>>(request);
  if (!body) return Response.json({ ok: false, error: "Invalid signature" }, { status: 401 });
  return Response.json({ ok: true });
};
