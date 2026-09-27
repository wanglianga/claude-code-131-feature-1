// 认证接口：POST /api/auth  {action: login|logout, username, password}
import { NextRequest, NextResponse } from "next/server";
import { verifyLogin, setSessionCookie, clearSessionCookie, getSession } from "@/lib/auth";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  getDb(); // 确保初始化+种子
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "login");
  if (action === "logout") {
    await clearSessionCookie();
    return NextResponse.json({ ok: true });
  }
  const user = verifyLogin(String(body.username || ""), String(body.password || ""));
  if (!user) {
    return NextResponse.json({ ok: false, error: "用户名或密码错误" }, { status: 401 });
  }
  await setSessionCookie(user);
  return NextResponse.json({ ok: true, user });
}

export async function GET() {
  getDb();
  const user = await getSession();
  return NextResponse.json({ ok: true, user });
}
