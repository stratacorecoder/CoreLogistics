import { LoginInputSchema, LoginResponseSchema, OkSchema, SessionUserSchema } from "@corelogistics/contracts";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { unauthorized } from "../../errors.js";
import { buildSessionCookie, login, logout, sessionUser, tokenOf } from "./service.js";

export default async function authRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ["auth"];

  r.post(
    "/auth/login",
    { schema: { tags, body: LoginInputSchema, response: { 200: LoginResponseSchema } } },
    async (req, reply) => {
      const result = login(req.body, req.ip);
      reply.header("Set-Cookie", buildSessionCookie(result.token, req));
      return result;
    },
  );

  r.get("/auth/me", { schema: { tags, response: { 200: SessionUserSchema } } }, async (req) => {
    const user = sessionUser(tokenOf(req));
    if (!user) throw unauthorized("Sign in");
    return user;
  });

  r.post("/auth/logout", { schema: { tags, response: { 200: OkSchema } } }, async (req, reply) => {
    logout(tokenOf(req));
    reply.header("Set-Cookie", buildSessionCookie("", req, 0));
    return { ok: true as const };
  });
}
