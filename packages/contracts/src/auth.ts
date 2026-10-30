import { z } from "zod";

export const APP_ROLE_IDS = ["tower", "gate", "warehouse", "driver"] as const;
export const AppRoleIdSchema = z.enum(APP_ROLE_IDS);
export type AppRoleId = z.infer<typeof AppRoleIdSchema>;

export const SessionUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  role: AppRoleIdSchema,
  driverId: z.string().nullable(),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

export const LoginInputSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

export const LoginResponseSchema = z.object({
  token: z.string(),
  user: SessionUserSchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
