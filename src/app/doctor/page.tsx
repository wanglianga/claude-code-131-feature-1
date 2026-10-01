import Link from "next/link";
import { q, today } from "@/lib/db";
import { requireUser } from "@/lib/guard";
import { AppShell, Section, DataTable, Badge } from "@/components/ui";
import { DataForm } from "@/components/client";
import { JaundiceCasePanel } from "@/components/jaundice";
import { listJaundiceCases } from "@/lib/jaundice";
import { EX_STATUS, JAUNDICE_LEVELS, JAUNDICE_STATUSES, dt, badgeClass, jaundiceLevelClass, jaundiceStatusClass } from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function DoctorPage() {
  const user = await requireUser(["pediatrician", "admin"]);
  const todayStr = today();
  const inStays = q(
    `SELECT s.id, s.mother_name, s.baby_name, s.baby_weight, s.jaundice_level, s.jaundice_note, r.number
     FROM stays s JOIN rooms r ON r.id=s.room_id WHERE s.status='in_stay' ORDER BY r.number`);
  const jaundiceAlerts = q(
    `SELECT e.*, r.number, s.baby_name FROM exceptions e
     JOIN stays s ON s.id=e.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE e.type='jaundice' AND e.status IN ('open','processing') ORDER BY e.created_at DESC`);
  const myRounds = q(
    `SELECT dr.*, r.number, s.mother_name FROM doctor_rounds dr
     JOIN stays s ON s.id=dr.stay_id JOIN rooms r ON r.id=s.room_id
     ORDER BY dr.round_date DESC LIMIT 15`);

  // 黄疸闭环：待当班评估确认 / 待返中心复核（含外院建议冲突）
  const jcases = listJaundiceCases({ openOnly: true });
  const awaitingConfirm = jcases.filter((c) => ["reported", "doctor_confirming"].includes(String(c.status)));
  const awaitingReview = jcases.filter((c) => ["returned", "conflict_review"].includes(String(c.status)));
  const otherFlow = jcases.filter((c) =>
    !["reported", "doctor_confirming", "returned", "conflict_review"].includes(String(c.status)));

  return (
    <AppShell title="儿科医生工作台">
      <div className="grid cols-4">
        <div className="stat"><div className="num">{inStays.length}</div><div className="label">在住宝宝</div></div>
        <div className="stat"><div className="num">{awaitingConfirm.length}</div><div className="label">黄疸待当班确认</div></div>
        <div className="stat"><div className="num">{awaitingReview.length}</div><div className="label">返中心待复核</div></div>
        <div className="stat"><div className="num">{myRounds.filter((r) => r.round_date === todayStr).length}</div><div className="label">今日巡诊</div></div>
      </div>

      <Section title="黄疸分级处置 · 待医生当班评估确认" tone={awaitingConfirm.length ? "tone-red" : ""}
        extra={<Badge text={`${awaitingConfirm.length} 件`} cls="badge red" />}>
        {awaitingConfirm.length === 0 && <div className="empty">暂无待确认的黄疸上报；医生确认前家属端不展示处理建议</div>}
        {awaitingConfirm.map((c) => (
          <details key={String(c.id)} open className="jc-case">
            <summary>
              <span className="row" style={{ gap: 8 }}>
                <b>{String(c.code)}</b>
                <Link href={`/stays/${c.stay_id}`}>{String(c.room_number)}房 宝宝{String(c.baby_name)}</Link>
                <Badge text={JAUNDICE_LEVELS[String(c.level)] || ""} cls={jaundiceLevelClass(String(c.level))} />
                <Badge text={JAUNDICE_STATUSES[String(c.status)] || ""} cls={jaundiceStatusClass(String(c.status))} />
                <span className="muted small">最新 {String(c.last_method)} {String(c.last_value)}mg/dL</span>
              </span>
            </summary>
            <div className="mt8"><JaundiceCasePanel caseId={Number(c.id)} user={user} /></div>
          </details>
        ))}
      </Section>

      <Section title="黄疸返中心 · 外院回执/冲突复核（必须医生复核后才能恢复常规护理）" tone={awaitingReview.length ? "tone-red" : ""}>
        {awaitingReview.length === 0 && <div className="empty">暂无待复核的返中心事件</div>}
        {awaitingReview.map((c) => (
          <details key={String(c.id)} open className="jc-case">
            <summary>
              <span className="row" style={{ gap: 8 }}>
                <b>{String(c.code)}</b>
                <Link href={`/stays/${c.stay_id}`}>{String(c.room_number)}房 宝宝{String(c.baby_name)}</Link>
                <Badge text={JAUNDICE_STATUSES[String(c.status)] || ""} cls={jaundiceStatusClass(String(c.status))} />
                <span className="muted small">返中心 {dt(c.returned_at)}</span>
              </span>
            </summary>
            <div className="mt8"><JaundiceCasePanel caseId={Number(c.id)} user={user} /></div>
          </details>
        ))}
      </Section>

      {otherFlow.length > 0 && (
        <Section title="转诊流程中的黄疸事件">
          <DataTable cols={["闭环", "房间", "宝宝", "分级", "状态", "最新值", ""]}
            rows={otherFlow.map((c) => [
              String(c.code),
              <Link key="r" href={`/stays/${c.stay_id}`}>{String(c.room_number)}</Link>,
              String(c.baby_name),
              <Badge key="l" text={JAUNDICE_LEVELS[String(c.level)] || ""} cls={jaundiceLevelClass(String(c.level))} />,
              <Badge key="s" text={JAUNDICE_STATUSES[String(c.status)] || ""} cls={jaundiceStatusClass(String(c.status))} />,
              <span key="v">{String(c.last_value ?? "-")} mg/dL</span>,
              <Link key="go" href={`/stays/${c.stay_id}#jaundice`}>进入</Link>,
            ])} />
        </Section>
      )}

      <Section title="历史黄疸预警工单（异常中心联动）">
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
