import type { ActionFunctionArgs } from "react-router";
import {
  action as productsAction,
  loader as productsLoader,
} from "./api.proxy.products";
import { action as cartAddAction } from "./api.proxy.cart.add";
import { loader as commerceLoader } from "./api.proxy.commerce";

export const loader = async (args: Parameters<typeof productsLoader>[0]) => {
  const splat = args.params["*"] ?? "";
  if (splat === "commerce" || splat.endsWith("/commerce")) {
    return commerceLoader(args);
  }
  return productsLoader(args);
};

export const action = async (args: ActionFunctionArgs) => {
  const splat = args.params["*"] ?? "";
  if (splat === "cart/add" || splat.endsWith("/cart/add")) {
    return cartAddAction(args);
  }
  if (
    splat === "products" ||
    splat.endsWith("/products") ||
    splat === "" ||
    splat === "products/search" ||
    splat.endsWith("/products/search")
  ) {
    return productsAction(args);
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};
