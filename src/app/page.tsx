import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ROLE_HOME } from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function Home() {
  getDb();
  const user = await getSession();
  if (!user) redirect("/login");
  redirect(ROLE_HOME[user.role] || "/login");
}
