// 房间列表（员工可读，用于前台排房与冒烟测试）
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb, q } from "@/lib/db";

export async function GET() {
  getDb();
  const user = await getSession();
  if (!user || user.role === "family") {
    return NextResponse.json({ ok: false, error: "未授权" }, { status: 401 });
  }
  const rooms = q("SELECT * FROM rooms ORDER BY number");
  return NextResponse.json({ ok: true, rooms });
}
