// 页面级角色守卫（服务端）
import { redirect } from "next/navigation";
import { getSession, type SessionUser } from "./auth";
import { getDb } from "./db";
import { ROLE_HOME } from "./labels";

export async function requireUser(roles?: string[]): Promise<SessionUser> {
  getDb();
  const user = await getSession();
  if (!user) redirect("/login");
  if (roles && !roles.includes(user.role)) {
    redirect(ROLE_HOME[user.role] || "/login");
  }
  return user;
}

export const STAFF_ROLES = ["admin", "head_nurse", "nurse", "matron", "pediatrician", "nutritionist", "therapist", "frontdesk", "finance"];

export function can(user: SessionUser, roles: string[]): boolean {
  return roles.includes(user.role);
}
