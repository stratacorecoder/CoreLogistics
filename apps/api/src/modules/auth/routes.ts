import { LoginInputSchema, LoginResponseSchema, OkSchema, SessionUserSchema } from "@corelogistics/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { unauthorized } from "../../errors.js";
import { login, logout, sessionUser, tokenOf } from "./service.js";

export default async function authRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ["auth"];

  r.post(
    "/auth/login",
    { schema: { tags, body: LoginInputSchema, response: { 200: LoginResponseSchema } } },
    async (req) => login(req.body),
  );

  r.get("/auth/me", { schema: { tags, response: { 200: SessionUserSchema } } }, async (req) => {
    const user = sessionUser(tokenOf(req));
    if (!user) throw unauthorized("Sign in");
    return user;
  });

  r.post("/auth/logout", { schema: { tags, response: { 200: OkSchema } } }, async (req) => {
    logout(tokenOf(req));
    return { ok: true as const };
  });
}
