import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { LoginForm } from "@/components/client";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  getDb();
  const user = await getSession();
  if (user) redirect("/");
  return (
    <div className="login-page">
      <div className="login-card">
        <h1>悦安月子中心</h1>
        <div className="sub">产妇护理计划与家属探访平台</div>
        <LoginForm />
        <div className="login-tip">
          测试账号（密码见 README）：<br />
          管理 <code>admin</code> · 护士长 <code>headnurse</code> · 护理 <code>nurse1</code> · 医生 <code>doctor</code><br />
          营养 <code>nutrition</code> · 产康 <code>therapist</code> · 月嫂 <code>matron</code><br />
          前台 <code>front</code> · 财务 <code>finance</code> · 家属 <code>family1</code>
        </div>
      </div>
    </div>
  );
}
