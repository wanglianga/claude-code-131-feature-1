// 统一业务动作入口：POST /api/do  {action: "tasks.update", ...payload}
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { runAction } from "@/lib/actions";

export async function POST(req: NextRequest) {
  getDb();
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ ok: false, error: "未登录或会话已过期" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  try {
    const result = runAction(user, action, body);
    return NextResponse.json({ ok: true, ...(typeof result === "object" && result !== null ? result : {}) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "操作失败";
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
