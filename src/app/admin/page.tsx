import Link from "next/link";
import { q, q1, today } from "@/lib/db";
import { requireUser } from "@/lib/guard";
import { AppShell, Section, DataTable, Badge } from "@/components/ui";
import { EX_TYPES, EX_STATUS, SEVERITY, money, dt, badgeClass, severityClass } from "@/lib/labels";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  await requireUser(["admin"]);
  const todayStr = today();

  const rooms = q(
    `SELECT s.id AS stay_id, s.mother_name, s.baby_name, s.status, r.number, r.type AS room_type, p.name AS package_name,
       (SELECT COUNT(*) FROM care_tasks t WHERE t.stay_id=s.id AND t.done_at LIKE ?) AS tasks_today,
       (SELECT COUNT(*) FROM care_records cr WHERE cr.stay_id=s.id AND cr.created_at LIKE ?) AS records_today,
       (SELECT COUNT(*) FROM exceptions e WHERE e.stay_id=s.id AND e.status IN ('open','processing')) AS open_ex,
       (SELECT MAX(CASE e.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END)
          FROM exceptions e WHERE e.stay_id=s.id AND e.status IN ('open','processing')) AS max_sev,
       (SELECT COALESCE(SUM(CASE WHEN f.direction='charge' THEN f.amount ELSE -f.amount END),0)
          FROM fees f WHERE f.stay_id=s.id AND f.created_at LIKE ? AND f.status='confirmed') AS fees_today,
       (SELECT COUNT(*) FROM visits v WHERE v.stay_id=s.id AND v.status='pending') AS pending_visits
     FROM stays s JOIN rooms r ON r.id=s.room_id JOIN packages p ON p.id=s.package_id
     WHERE s.status='in_stay' ORDER BY r.number`,
    `${todayStr}%`, `${todayStr}%`, `${todayStr}%`);

  const latestMsgs = q(
    `SELECT m.*, r.number FROM messages m JOIN stays s ON s.id=m.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE s.status='in_stay' ORDER BY m.created_at DESC LIMIT 6`);
  const complaints = q(
    `SELECT e.*, r.number, s.mother_name FROM exceptions e
     JOIN stays s ON s.id=e.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE e.type IN ('record_dispute','checkout_dispute','meal_taboo') AND e.status IN ('open','processing')
     ORDER BY e.created_at DESC`);
  const lowFeedbacks = q(
    `SELECT f.*, r.number, s.mother_name FROM feedbacks f
     JOIN stays s ON s.id=f.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE f.rating<=2 ORDER BY f.created_at DESC LIMIT 10`);
  const fbStats = q1(
    `SELECT COUNT(*) AS cnt, AVG(rating) AS avg_rating FROM feedbacks`);
  const openEx = q1(`SELECT COUNT(*) AS c FROM exceptions WHERE status IN ('open','processing')`);
  const pendingFollowUps = q(
    `SELECT f.*, s.mother_name, r.number FROM follow_ups f
     JOIN stays s ON s.id=f.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE f.status='pending' ORDER BY f.scheduled_at LIMIT 8`);

  const sevName = (n: unknown) => (Number(n) >= 3 ? "高" : Number(n) === 2 ? "中" : Number(n) === 1 ? "低" : "-");

  return (
    <AppShell title="中心管理看板（按房间）">
      <div className="grid cols-4">
        <div className="stat"><div className="num">{rooms.length}</div><div className="label">在住房间</div></div>
        <div className="stat"><div className="num">{Number(openEx?.c || 0)}</div><div className="label">待处理异常</div></div>
        <div className="stat"><div className="num">{complaints.length + lowFeedbacks.length}</div><div className="label">高敏感客诉</div></div>
        <div className="stat"><div className="num">{fbStats && fbStats.avg_rating ? Number(fbStats.avg_rating).toFixed(1) : "-"}</div><div className="label">家属口碑均分（{Number(fbStats?.cnt || 0)}条）</div></div>
      </div>

      <Section title="房间实时看板">
        <div className="grid cols-3">
          {rooms.map((r) => (
            <div className="stat room-card" key={String(r.stay_id)}>
              <div className="room-head">
                <span className="room-no">{String(r.number)}</span>
                <span className="badge blue">{String(r.room_type)}</span>
              </div>
              <div><b>{String(r.mother_name)}</b> · 宝宝{String(r.baby_name)}</div>
              <div className="small muted">{String(r.package_name)}</div>
              <div className="small">今日护理动作：<b>{Number(r.tasks_today) + Number(r.records_today)}</b> 项
                · 费用变化：<b>{money(r.fees_today)}</b></div>
              <div className="row">
                {Number(r.open_ex) > 0
                  ? <span className={`badge ${Number(r.max_sev) >= 3 ? "red" : "amber"}`}>异常 {Number(r.open_ex)} 件（最高{sevName(r.max_sev)}）</span>
                  : <span className="badge green">无未结异常</span>}
                {Number(r.pending_visits) > 0 && <span className="badge amber">待审探访 {Number(r.pending_visits)}</span>}
              </div>
              <Link href={`/stays/${r.stay_id}`} className="btn primary small">进入房间360视图</Link>
            </div>
          ))}
        </div>
      </Section>

      <div className="grid cols-2">
        <Section title="高敏感客诉（需优先处理）" tone="tone-red">
          <DataTable cols={["房间", "类型", "内容", "严重度", "状态"]} empty="暂无高敏感客诉"
            rows={complaints.map((e) => [
              <Link key="r" href={`/stays/${e.stay_id}`}>{String(e.number)}</Link>,
              EX_TYPES[String(e.type)] || String(e.type),
              <span key="c">{String(e.title)}<div className="muted small">{String(e.description)}</div></span>,
              <Badge key="s" text={SEVERITY[String(e.severity)] || ""} cls={severityClass(String(e.severity))} />,
              <Badge key="st" text={EX_STATUS[String(e.status)] || ""} cls={badgeClass(String(e.status))} />,
            ])} />
          <div className="mt8 muted small">低分反馈：</div>
          <DataTable cols={["房间", "评分", "内容", "状态"]} empty="暂无低分反馈"
            rows={lowFeedbacks.map((f) => [
              <Link key="r" href={`/stays/${f.stay_id}`}>{String(f.number)}</Link>,
              <span key="s" className="badge red">{"★".repeat(Number(f.rating))}</span>,
              String(f.content),
              <Badge key="st" text={f.status === "responded" ? "已回复" : "待回复"} cls={badgeClass(String(f.status))} />,
            ])} />
        </Section>

        <Section title="最新家属沟通">
          <ul className="timeline">
            {latestMsgs.map((m) => (
              <li key={String(m.id)}>
                <span className="t-time">{dt(m.created_at)}</span>
                <span className="badge blue">{String(m.number)}房</span> <b>{String(m.from_name)}</b>：{String(m.content)}
              </li>
            ))}
          </ul>
          <div className="mt8 muted small">待执行随访：</div>
          <DataTable cols={["房间", "类型", "计划时间", "内容"]} empty="暂无待执行随访"
            rows={pendingFollowUps.map((f) => [
              <Link key="r" href={`/stays/${f.stay_id}`}>{String(f.number)}</Link>,
              String(f.type), dt(f.scheduled_at), String(f.content),
            ])} />
        </Section>
      </div>
    </AppShell>
  );
}
