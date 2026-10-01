import Link from "next/link";
import { q, today } from "@/lib/db";
import { requireUser } from "@/lib/guard";
import { AppShell, Section, DataTable, Badge } from "@/components/ui";
import { DataForm } from "@/components/client";
import { JaundiceCaseCard } from "@/components/jaundice";
import { EX_STATUS, dt, badgeClass } from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function DoctorPage() {
  const user = await requireUser(["pediatrician", "admin"]);
  const todayStr = today();
  const inStays = q(
    `SELECT s.id, s.mother_name, s.baby_name, s.baby_weight, s.jaundice_level, s.jaundice_note, r.number
     FROM stays s JOIN rooms r ON r.id=s.room_id WHERE s.status='in_stay' ORDER BY r.number`);
  const jCases = q(
    `SELECT c.*, r.number FROM jaundice_cases c
     JOIN stays s ON s.id=c.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE c.status NOT IN ('routine_resumed','closed')
     ORDER BY CASE c.status WHEN 'review_conflict' THEN 0 WHEN 'returned_pending_review' THEN 1
       WHEN 'pending_doctor' THEN 2 ELSE 3 END, c.id DESC`);
  const pendingConfirm = jCases.filter((c) => ["pending_doctor", "doctor_confirmed"].includes(String(c.status)));
  const pendingReview = jCases.filter((c) => ["returned_pending_review", "review_conflict"].includes(String(c.status)));
  const jaundiceAlerts = q(
    `SELECT e.*, r.number, s.baby_name FROM exceptions e
     JOIN stays s ON s.id=e.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE e.type='jaundice' AND e.status IN ('open','processing') ORDER BY e.created_at DESC`);
  const myRounds = q(
    `SELECT dr.*, r.number, s.mother_name FROM doctor_rounds dr
     JOIN stays s ON s.id=dr.stay_id JOIN rooms r ON r.id=s.room_id
     ORDER BY dr.round_date DESC LIMIT 15`);

  return (
    <AppShell title="儿科医生工作台">
      <div className="grid cols-3">
        <div className="stat"><div className="num">{inStays.length}</div><div className="label">在住宝宝</div></div>
        <div className="stat"><div className="num">{pendingConfirm.length}</div><div className="label">待确认分级建议</div></div>
        <div className="stat"><div className="num">{pendingReview.length}</div><div className="label">返中心待复核</div></div>
      </div>

      <Section title="黄疸分级处置 · 待我确认 / 返中心复核" tone={jCases.length ? "tone-red" : ""}>
        <div className="muted small" style={{ marginBottom: 8 }}>
          家属端只展示您确认后的处理建议；建议转诊需家属确认后由护士长协调。返中心后若外院建议与原中心计划冲突，须您复核确认才能恢复常规护理。
        </div>
        {jCases.length === 0 && <div className="empty">暂无在办黄疸案例</div>}
        {jCases.map((c) => (
          <div key={Number(c.id)}>
            <div className="muted small">{String(c.number)}房</div>
            <JaundiceCaseCard c={c} role={user.role} detailed />
          </div>
        ))}
      </Section>

      <Section title="历史黄疸预警工单（异常中心）">
        <DataTable cols={["房间", "宝宝", "预警内容", "状态", "处理"]} empty="暂无黄疸预警"
          rows={jaundiceAlerts.map((e) => [
            <Link key="r" href={`/stays/${e.stay_id}`}>{String(e.number)}</Link>,
            String(e.baby_name),
            <span key="t">{String(e.title)}<div className="muted small">{String(e.description)}</div></span>,
            <Badge key="s" text={EX_STATUS[String(e.status)] || ""} cls={badgeClass(String(e.status))} />,
            <DataForm key="f" compact action="exceptions.update" hidden={{ id: Number(e.id) }}
              fields={[
                { name: "action", label: "操作", type: "select", required: true, options: [
                  { value: "accept", label: "受理" }, { value: "note", label: "追加记录" }, { value: "resolve", label: "解决" }] },
                { name: "note", label: "诊疗意见", required: true },
              ]} submitLabel="提交" />,
          ])} />
      </Section>

      <Section title="巡诊登记">
        <DataForm action="rounds.create"
          fields={[
            { name: "stayId", label: "房间", type: "select", required: true, options: inStays.map((s) => ({ value: String(s.id), label: `${s.number} ${s.mother_name}（宝宝${s.baby_name}）` })) },
            { name: "roundDate", label: "巡诊日期", type: "date", required: true, defaultValue: todayStr },
            { name: "findings", label: "查体发现", type: "textarea", required: true },
            { name: "advice", label: "医生建议", type: "textarea" },
            { name: "jaundiceLevel", label: "黄疸复测值(mg/dL，留空不更新)", type: "number", step: "0.1" },
            { name: "jaundiceNote", label: "黄疸观察备注" },
          ]} submitLabel="保存巡诊记录" />
      </Section>

      <div className="grid cols-2">
        <Section title="在住宝宝监测">
          <DataTable cols={["房间", "宝宝", "体重", "黄疸值", "观察"]}
            rows={inStays.map((s) => [
              <Link key="r" href={`/stays/${s.id}`}>{String(s.number)}</Link>,
              String(s.baby_name), `${s.baby_weight}kg`,
              <span key="j" className={Number(s.jaundice_level) >= 12 ? "badge red" : "badge green"}>{String(s.jaundice_level)} mg/dL</span>,
              <span key="n" className="small">{String(s.jaundice_note || "-")}</span>,
            ])} />
        </Section>
        <Section title="巡诊历史">
          <DataTable cols={["日期", "房间", "查体发现", "建议"]} empty="暂无巡诊记录"
            rows={myRounds.map((r) => [
              String(r.round_date),
              <Link key="r2" href={`/stays/${r.stay_id}`}>{String(r.number)}</Link>,
              String(r.findings), String(r.advice),
            ])} />
        </Section>
      </div>
    </AppShell>
  );
}
