import Link from "next/link";
import { q } from "@/lib/db";
import { requireUser } from "@/lib/guard";
import { AppShell, Section, DataTable, Badge } from "@/components/ui";
import { DataForm } from "@/components/client";
import { JaundiceCasePanel } from "@/components/jaundice";
import { listJaundiceCases, jaundiceOpenStats } from "@/lib/jaundice";
import { EX_TYPES, EX_STATUS, SEVERITY, JAUNDICE_LEVELS, JAUNDICE_STATUSES, dt, badgeClass, severityClass, jaundiceLevelClass, jaundiceStatusClass } from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function HeadNursePage() {
  const user = await requireUser(["head_nurse", "admin"]);
  const exceptions = q(
    `SELECT e.*, r.number, s.mother_name FROM exceptions e
     JOIN stays s ON s.id=e.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE e.status IN ('open','processing') ORDER BY
       CASE e.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, e.created_at DESC`);
  const disputes = q(
    `SELECT e.*, r.number, s.mother_name FROM exceptions e
     JOIN stays s ON s.id=e.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE e.synced_head_nurse=1 ORDER BY e.status='open' DESC, e.created_at DESC LIMIT 10`);
  const feedbacks = q(
    `SELECT f.*, r.number, s.mother_name FROM feedbacks f
     JOIN stays s ON s.id=f.stay_id JOIN rooms r ON r.id=s.room_id
     ORDER BY f.status='new' DESC, f.created_at DESC LIMIT 10`);
  const leaves = q(
    `SELECT e.*, r.number FROM exceptions e JOIN stays s ON s.id=e.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE e.type='matron_leave' AND e.status IN ('open','processing')`);
  const matrons = q("SELECT id,name FROM users WHERE active=1 AND role IN ('matron','nurse')");
  const inStays = q(
    `SELECT s.id, r.number, s.mother_name FROM stays s JOIN rooms r ON r.id=s.room_id
     WHERE s.status='in_stay' ORDER BY r.number`);
  const followUps = q(
    `SELECT f.*, r.number, s.mother_name FROM follow_ups f
     JOIN stays s ON s.id=f.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE f.status='pending' ORDER BY f.scheduled_at LIMIT 10`);

  // 黄疸闭环：转诊延迟/家属拒绝自动升级；复核重建完成待护理主管核对关闭
  const jStats = jaundiceOpenStats();
  const jCases = listJaundiceCases({ openOnly: true });
  const jEscalated = jCases.filter((c) => String(c.status) === "upgraded" || String(c.status) === "family_declined");
  const jResolved = listJaundiceCases({}).filter((c) => String(c.status) === "resolved");

  return (
    <AppShell title="护士长工作台">
      <div className="grid cols-4">
        <div className="stat"><div className="num">{exceptions.length}</div><div className="label">待处理异常工单</div></div>
        <div className="stat"><div className="num">{Number(jStats.upgraded || 0) + Number(jStats.family_declined || 0)}</div><div className="label">黄疸转诊升级/家属拒绝</div></div>
        <div className="stat"><div className="num">{Number(jStats.awaiting_doctor || 0) + Number(jStats.referral_flow || 0)}</div><div className="label">黄疸处置进行中</div></div>
        <div className="stat"><div className="num">{jResolved.length}</div><div className="label">黄疸闭环待核对关闭</div></div>
      </div>

      <Section title="黄疸转诊升级看板（车辆/家属拒绝导致延迟 · 风险留痕）" tone={jEscalated.length ? "tone-red" : ""}>
        {jEscalated.length === 0 && <div className="empty">暂无转诊延迟升级事件</div>}
        {jEscalated.map((c) => (
          <details key={String(c.id)} open className="jc-case">
            <summary>
              <span className="row" style={{ gap: 8 }}>
                <b>{String(c.code)}</b>
                <Link href={`/stays/${c.stay_id}`}>{String(c.room_number)}房 宝宝{String(c.baby_name)}</Link>
                <Badge text={JAUNDICE_LEVELS[String(c.level)] || ""} cls={jaundiceLevelClass(String(c.level))} />
                <Badge text={JAUNDICE_STATUSES[String(c.status)] || ""} cls={jaundiceStatusClass(String(c.status))} />
                <span className="muted small">升级原因：{String(c.escalate_reason)}</span>
              </span>
            </summary>
            <div className="jc-risk mt8">⚠ {String(c.risk_note)}</div>
            <div className="mt8"><JaundiceCasePanel caseId={Number(c.id)} user={user} /></div>
          </details>
        ))}
      </Section>

      <Section title="黄疸闭环护理主管核对（全程时间线 / 交接材料 / 未完成事项）">
        {jResolved.length === 0 && <div className="empty">暂无待关闭闭环；关闭前系统将校验未完成事项必须全部办结</div>}
        {jResolved.map((c) => (
          <details key={String(c.id)} className="jc-case">
            <summary>
              <span className="row" style={{ gap: 8 }}>
                <b>{String(c.code)}</b>
                <Link href={`/stays/${c.stay_id}`}>{String(c.room_number)}房 宝宝{String(c.baby_name)}</Link>
                <Badge text={JAUNDICE_STATUSES[String(c.status)] || ""} cls={jaundiceStatusClass(String(c.status))} />
                <span className="muted small">未完成事项 {String(c.pending_todos)} 项</span>
              </span>
            </summary>
            <div className="mt8"><JaundiceCasePanel caseId={Number(c.id)} user={user} /></div>
          </details>
        ))}
      </Section>

      <Section title="异常工单中心（全中心）" tone={exceptions.length ? "tone-red" : ""}>
        <DataTable cols={["房间", "类型", "标题", "严重度", "状态", "责任角色", "处理"]} empty="暂无待处理异常"
          rows={exceptions.map((e) => [
            <Link key="r" href={`/stays/${e.stay_id}`}>{String(e.number)}</Link>,
            EX_TYPES[String(e.type)] || String(e.type),
            <span key="t">{String(e.title)}<div className="muted small">{String(e.description)}</div></span>,
            <Badge key="s" text={SEVERITY[String(e.severity)] || ""} cls={severityClass(String(e.severity))} />,
            <Badge key="st" text={EX_STATUS[String(e.status)] || ""} cls={badgeClass(String(e.status))} />,
            String(e.assigned_role),
            <DataForm key="f" compact action="exceptions.update" hidden={{ id: Number(e.id) }}
              fields={[
                { name: "action", label: "操作", type: "select", required: true, options: [
                  { value: "accept", label: "受理" }, { value: "note", label: "追加记录" },
                  { value: "resolve", label: "解决" }, { value: "close", label: "关闭" }] },
                { name: "note", label: "处理说明" },
              ]} submitLabel="提交" />,
          ])} />
      </Section>

      <div className="grid cols-2">
        <Section title="退所争议 / 护理记录质疑（同步护士长）">
          <DataTable cols={["房间", "类型", "标题", "状态", "解决情况"]} empty="暂无争议"
            rows={disputes.map((e) => [
              <Link key="r" href={`/stays/${e.stay_id}`}>{String(e.number)}</Link>,
              EX_TYPES[String(e.type)] || String(e.type),
              String(e.title),
              <Badge key="st" text={EX_STATUS[String(e.status)] || ""} cls={badgeClass(String(e.status))} />,
              <span key="res" className="small">{String(e.resolution || "处理中")}</span>,
            ])} />
        </Section>

        <Section title="月嫂请假协调">
          <DataTable cols={["房间", "请假事由", "状态", "替班安排"]} empty="暂无请假"
            rows={leaves.map((e) => [
              <Link key="r" href={`/stays/${e.stay_id}`}>{String(e.number)}</Link>,
              <span key="t">{String(e.title)}<div className="muted small">{String(e.description)}</div></span>,
              <Badge key="st" text={EX_STATUS[String(e.status)] || ""} cls={badgeClass(String(e.status))} />,
              <DataForm key="f" compact action="matron.leave" hidden={{ stayId: Number(e.stay_id) }}
                fields={[
                  { name: "fromDate", label: "开始", type: "date", required: true },
                  { name: "toDate", label: "结束", type: "date", required: true },
                  { name: "reason", label: "说明", defaultValue: "替班安排" },
                  { name: "reassignTo", label: "替班人员", type: "select", options: matrons.map((m) => ({ value: String(m.id), label: String(m.name) })) },
                ]} submitLabel="改派夜间照护" />,
            ])} />
          <div className="muted small mt8">在住房间：
            {inStays.map((s) => (
              <Link key={String(s.id)} href={`/stays/${s.id}`} className="badge blue" style={{ marginRight: 6 }}>
                {String(s.number)} {String(s.mother_name)}
              </Link>
            ))}
          </div>
        </Section>
      </div>

      <div className="grid cols-2">
        <Section title="家属反馈（回复并标记是否影响排班）">
          <DataTable cols={["房间", "评分", "内容", "回复"]} empty="暂无反馈"
            rows={feedbacks.map((f) => [
              <Link key="r" href={`/stays/${f.stay_id}`}>{String(f.number)}</Link>,
              <span key="s" className={Number(f.rating) <= 2 ? "badge red" : "badge green"}>{"★".repeat(Number(f.rating))}</span>,
              <span key="c">{String(f.content)}{Number(f.affect_scheduling) ? <span className="badge amber">影响排班</span> : null}</span>,
              f.status === "new" ? (
                <DataForm key="rf" compact action="feedbacks.respond" hidden={{ id: Number(f.id) }}
                  fields={[
                    { name: "response", label: "回复内容", required: true },
                    { name: "affectScheduling", label: "影响护理师排班", type: "checkbox" },
                  ]} submitLabel="回复" />
              ) : <span key="resp" className="small">{String(f.response)}</span>,
            ])} />
        </Section>

        <Section title="出所后回访 / 母婴随访">
          <DataTable cols={["房间", "类型", "计划时间", "内容", "结果"]} empty="暂无待执行随访"
            rows={followUps.map((f) => [
              <Link key="r" href={`/stays/${f.stay_id}`}>{String(f.number)}</Link>,
              String(f.type), dt(f.scheduled_at), String(f.content),
              <DataForm key="ff" compact action="followups.done" hidden={{ id: Number(f.id) }}
                fields={[{ name: "result", label: "随访结果", required: true }]} submitLabel="完成" />,
            ])} />
        </Section>
      </div>
    </AppShell>
  );
}
