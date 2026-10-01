// 黄疸分级处置 + 转诊闭环的共享视图（服务端组件），按角色渲染对应操作。
import Link from "next/link";
import { q } from "@/lib/db";
import { Section, Badge, DataTable, KV } from "./ui";
import { DataForm, ActionButton } from "./client";
import {
  JAUNDICE_GRADE_LABEL, JAUNDICE_STATUS_LABEL, DECISION_LABEL, TREND_LABEL,
  VEHICLE_LABEL, jaundiceStatusClass, TERMINAL,
} from "@/lib/jaundice";
import { dt } from "@/lib/labels";

type Row = Record<string, unknown>;
const s = (v: unknown) => String(v ?? "");
const num = (v: unknown) => Number(v ?? 0);

const ACTION_LABEL: Record<string, string> = {
  created: "建立案例",
  measured: "测量分级",
  escalated: "自动升级",
  doctor_confirmed: "医生确认",
  reminder: "下发复测提醒",
  family_confirmed: "家属确认转诊",
  family_declined: "家属暂拒转诊",
  coordinated: "转诊协调",
  delay_resolved: "延迟事项闭环",
  delay: "转诊延迟",
  departed: "转诊出发",
  arrived: "送达外院",
  returned: "返中心登记",
  reviewed: "医生复核",
  plan_rebuilt: "重建观察计划",
  routine_resumed: "恢复常规护理",
  closed: "关闭观察",
};

function gradeBadge(grade: string) {
  const cls =
    grade === "urgent_referral" ? "badge red"
    : grade === "doctor_eval" ? "badge red"
    : grade === "enhanced" ? "badge amber"
    : "badge green";
  return <Badge text={JAUNDICE_GRADE_LABEL[grade] || grade} cls={cls} />;
}

function Timeline({ events }: { events: Row[] }) {
  if (!events.length) return <div className="muted small">暂无时间线</div>;
  return (
    <ul className="timeline">
      {events.map((e) => (
        <li key={num(e.id)}>
          <span className="t-time">{dt(e.created_at)}</span>
          <b>{s(e.user_name)}</b>
          <span className="badge blue" style={{ marginLeft: 4 }}>{ACTION_LABEL[s(e.action)] || s(e.action)}</span>
          ：{s(e.note)}
        </li>
      ))}
    </ul>
  );
}

function Records({ records }: { records: Row[] }) {
  if (!records.length) return null;
  return (
    <details>
      <summary className="muted small">测量明细（测量时间/方式/趋势/喂养/排泄/分级）</summary>
      <div className="mt8">
        <DataTable cols={["测量时间", "方式", "数值", "趋势", "喂养", "排泄", "分级"]}
          rows={records.map((r) => [
            <span key="t" className="small">{dt(r.measured_at)}</span>,
            s(r.method),
            <b key="v">{s(r.level)} mg/dL</b>,
            TREND_LABEL[s(r.trend)] || s(r.trend),
            <span key="f" className="small">{s(r.feeding || "-")}</span>,
            <span key="st" className="small">{s(r.stool || "-")}</span>,
            gradeBadge(s(r.grade)),
          ])} />
        <div className="muted small mt8">
          {records.map((r) => (
            <div key={num(r.id)}>
              既往观察计划：{s(r.prev_plan || "-")}；既往医生建议：{s(r.prev_advice || "-") || "无"}
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

// 未完成事项（避免复测/转诊/返中心记录脱节）
function PendingItems({ c }: { c: Row }) {
  const st = s(c.status);
  const items: string[] = [];
  if (st === "pending_doctor") items.push("等待儿科医生确认分级处理建议");
  if (st === "doctor_confirmed") items.push("按医生确认建议加强复测，复测稳定后由医生关闭观察");
  if (st === "referral_pending_family") items.push("等待家属确认转诊（未确认前不得启动转诊）");
  if (st === "referral_confirmed") items.push("待护士长协调车辆 / 陪同人员 / 目标医院 / 中心护理交接");
  if (st === "coordinating") items.push("转诊已协调，待登记出发");
  if (st === "delayed_escalated") items.push("转诊延迟已升级护士长，需尽快重新协调并与家属沟通");
  if (st === "referred") items.push("转诊在途，待登记到达外院");
  if (st === "at_hospital") items.push("外院就诊中，待宝宝返中心并登记外院回执");
  if (st === "returned_pending_review") items.push("待儿科医生依据外院回执复核并重建观察计划");
  if (st === "review_conflict") items.push("外院建议与原中心计划冲突，必须由医生复核后方可恢复常规护理");
  if (!items.length) return null;
  return (
    <div className="tone-red-inner" style={{ padding: "8px 10px", border: "1px solid #f3c9c9", borderRadius: 8, background: "#fff6f6" }}>
      <b>未完成事项：</b>
      <ul style={{ margin: "4px 0 0 18px" }}>
        {items.map((t) => <li key={t} className="small">{t}</li>)}
      </ul>
    </div>
  );
}

function DoctorActions({ c }: { c: Row }) {
  const st = s(c.status);
  if (st === "pending_doctor" || st === "doctor_confirmed") {
    return (
      <div className="grid cols-2">
        <DataForm compact action="jaundice.doctorConfirm" hidden={{ caseId: num(c.id) }}
          fields={[
            { name: "decision", label: "处置决定", type: "select", required: true,
              defaultValue: c.grade === "urgent_referral" ? "referral" : c.grade === "doctor_eval" ? "doctor_eval" : "enhanced_retest",
              options: [
                { value: "enhanced_retest", label: "加强复测" },
                { value: "doctor_eval", label: "医生当班评估" },
                { value: "referral", label: "建议转诊（外院）" }] },
            { name: "advice", label: "经确认的处理建议（家属端仅展示此内容）", type: "textarea", required: true,
              defaultValue: s(c.doctor_advice) },
            { name: "retestAt", label: "复测/评估时间（非转诊时下发排班）", type: "datetime-local" },
          ]} submitLabel="医生确认建议" />
        <DataForm compact action="jaundice.close" hidden={{ caseId: num(c.id) }}
          fields={[{ name: "note", label: "复测已稳定，关闭观察说明", required: true }]}
          submitLabel="复测稳定·关闭观察" />
      </div>
    );
  }
  if (st === "returned_pending_review" || st === "review_conflict") {
    const nurses = q("SELECT id,name FROM users WHERE active=1 AND role IN ('nurse','matron') ORDER BY role,id");
    return (
      <div className="tone-red-inner" style={{ padding: 10, border: "1px solid #f0d9a8", borderRadius: 8, background: "#fffaf0" }}>
        <div className="small"><b>外院回执：</b>{s(c.external_receipt)}</div>
        <div className="small mt8"><b>外院建议：</b>{s(c.external_advice)}</div>
        {num(c.plan_conflict) === 1 && (
          <div className="badge red mt8">与原中心计划冲突：{s(c.conflict_detail)}</div>
        )}
        <div className="mt8">
          <DataForm compact action="jaundice.resume" hidden={{ caseId: num(c.id) }}
            fields={[
              { name: "newAdvice", label: "医生新建议（复核后生效）", type: "textarea", required: true },
              { name: "frequency", label: "复测频次", defaultValue: "每日2次" },
              { name: "assigneeId", label: "同步护理师排班", type: "select",
                options: nurses.map((u) => ({ value: s(u.id), label: s(u.name) })) },
              { name: "planTimes", label: "复测排班时间（每行一个，如 2026-09-26 09:00；留空默认今日16:00/20:00）", type: "textarea" },
              ...(st === "review_conflict" ? [{ name: "conflictResolved", label: "我已逐项复核冲突，并按医嘱确定新方案", type: "checkbox" as const, required: true }] : []),
            ]} submitLabel="复核并重建观察计划·恢复常规护理" />
        </div>
      </div>
    );
  }
  return null;
}

function ReferralCoordination({ c, role }: { c: Row; role: string }) {
  const st = s(c.status);
  const isHead = role === "head_nurse" || role === "admin";
  if (!["referral_confirmed", "coordinating", "delayed_escalated", "referred", "at_hospital"].includes(st)) return null;
  const staff = q("SELECT id,name,role FROM users WHERE active=1 AND role IN ('nurse','matron','head_nurse') ORDER BY role,id");
  return (
    <div>
      <KV items={[
        ["车辆", `${VEHICLE_LABEL[s(c.vehicle_status)] || s(c.vehicle_status)}${c.vehicle_info ? " · " + s(c.vehicle_info) : ""}`],
        ["陪同人员", s(c.escort_name) || "-"],
        ["目标医院", s(c.target_hospital) || "-"],
        ["中心护理交接", s(c.handoff) || "-"],
        ["协调人/时间", c.coordinated_by_name ? `${s(c.coordinated_by_name)} · ${dt(c.coordinated_at)}` : "-"],
        ["出发/到达", `${c.departed_at ? dt(c.departed_at) : "未出发"} / ${c.arrived_at ? dt(c.arrived_at) : "未到达"}`],
      ]} />
      {num(c.delayed) === 1 && (
        <div className="badge red" style={{ display: "block", padding: 8, margin: "8px 0" }}>
          转诊延迟已升级护士长：{s(c.delay_reason)}<br />
          <span className="small">风险说明：{s(c.risk_note)}</span>
        </div>
      )}
      {(st === "referral_confirmed" || st === "coordinating" || st === "delayed_escalated") && (
        <div className="grid cols-2">
          {isHead && (
            <DataForm compact action="jaundice.coordinate" hidden={{ caseId: num(c.id) }}
              fields={[
                { name: "vehicleInfo", label: "车辆安排（车牌/司机/方式）", required: true, defaultValue: s(c.vehicle_info) },
                { name: "escortName", label: "陪同人员", required: true, defaultValue: s(c.escort_name) },
                { name: "escortId", label: "陪同人员账号", type: "select",
                  options: staff.map((u) => ({ value: s(u.id), label: s(u.name) })) },
                { name: "targetHospital", label: "目标医院", required: true, defaultValue: s(c.target_hospital) },
                { name: "handoff", label: "中心护理交接材料（喂养/黄疸/用药/用品）", type: "textarea", defaultValue: s(c.handoff) },
              ]} submitLabel="保存转诊协调" />
          )}
          {(isHead || role === "nurse") && (
            <DataForm compact action="jaundice.reportDelay" hidden={{ caseId: num(c.id) }}
              fields={[
                { name: "reasonType", label: "延迟原因类型", type: "select", required: true, options: [
                  { value: "vehicle_declined", label: "车辆无法安排/拒绝" },
                  { value: "family_declined", label: "家属拒绝/临时变卦" },
                  { value: "other", label: "其他" }] },
                { name: "reason", label: "延迟情况", type: "textarea", required: true },
                { name: "riskNote", label: "风险说明（留存并升级护士长）", type: "textarea", required: true },
              ]} submitLabel="登记转诊延迟（自动升级）" />
          )}
        </div>
      )}
      <div className="row mt8">
        {(st === "coordinating") && (isHead || role === "nurse") && (
          <ActionButton action="jaundice.depart" payload={{ caseId: num(c.id) }} label="登记转诊出发" kind="primary" />
        )}
        {st === "referred" && (isHead || role === "nurse") && (
          <DataForm compact action="jaundice.arrive" hidden={{ caseId: num(c.id) }}
            fields={[{ name: "note", label: "到达交接备注" }]} submitLabel="登记到达外院" />
        )}
        {(st === "at_hospital" || st === "referred") && (isHead || role === "nurse") && (
          <DataForm compact action="jaundice.return" hidden={{ caseId: num(c.id) }}
            fields={[
              { name: "externalReceipt", label: "外院回执（诊断/处置）", type: "textarea", required: true },
              { name: "externalAdvice", label: "外院建议", type: "textarea", required: true },
              { name: "conflict", label: "外院建议与原中心观察计划冲突", type: "checkbox" },
              { name: "conflictDetail", label: "冲突点说明（勾选时必填）", type: "textarea" },
            ]} submitLabel="宝宝返中心·登记回执" />
        )}
      </div>
    </div>
  );
}

// 员工视角的单个黄疸案例卡片（房间360 / 各角色工作台复用）
export function JaundiceCaseCard({ c, role, detailed = true }: { c: Row; role: string; detailed?: boolean }) {
  const records = q("SELECT * FROM jaundice_records WHERE case_id=? ORDER BY id DESC", num(c.id));
  const events = q("SELECT * FROM jaundice_events WHERE case_id=? ORDER BY id ASC", num(c.id));
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-head">
        <h2 style={{ margin: 0 }}>
          黄疸案例 #{num(c.id)}
          <span style={{ marginLeft: 8 }}>{gradeBadge(s(c.grade))}</span>
          <Badge text={JAUNDICE_STATUS_LABEL[s(c.status)] || s(c.status)} cls={jaundiceStatusClass(s(c.status))} />
          {num(c.delayed) === 1 && <Badge text="转诊延迟·已升级" cls="badge red" />}
        </h2>
        <Link className="muted small" href={`/stays/${num(c.stay_id)}`}>房间视图</Link>
      </div>
      <div className="card-body">
        <KV items={[
          ["最新测量", `${s(c.latest_level)} mg/dL`],
          ["医生决定", c.doctor_decision ? DECISION_LABEL[s(c.doctor_decision)] || s(c.doctor_decision) : "待医生确认"],
          ["医生确认建议", s(c.doctor_advice) || "—（确认前不得告知家属/承诺转诊）"],
          ...(c.doctor_confirmed_at ? [["医生确认时间", dt(c.doctor_confirmed_at)]] as [string, React.ReactNode][] : []),
          ["家属确认", num(c.family_confirmed) === 1 ? `已确认 · ${dt(c.family_confirmed_at)}` : (s(c.status) === "referral_pending_family" ? "待确认" : "—")],
        ]} />
        <div className="mt8"><PendingItems c={c} /></div>
        {detailed && <div className="mt8"><Records records={records} /></div>}
        <div className="mt8"><ReferralCoordination c={c} role={role} /></div>
        {(role === "pediatrician" || role === "admin") && <div className="mt8"><DoctorActions c={c} /></div>}
        {detailed && (
          <details className="mt8" open={TERMINAL.includes(s(c.status))}>
            <summary className="muted">全程时间线（{events.length}）</summary>
            <div className="mt8"><Timeline events={events} /></div>
          </details>
        )}
        {TERMINAL.includes(s(c.status)) && (
          <div className="mt8 small">
            {num(c.plan_rebuilt) === 1 && <div className="badge green">观察计划已重建</div>}
            <span className="muted">{s(c.rebuilt_detail)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// 护理师：测量录入表单
export function NurseMeasureForm({ stays }: { stays: Row[] }) {
  return (
    <DataForm action="jaundice.measure"
      fields={[
        { name: "stayId", label: "房间 / 宝宝", type: "select", required: true,
          options: stays.map((x) => ({ value: s(x.id), label: `${s(x.number)} ${s(x.mother_name)}（宝宝${s(x.baby_name)}）` })) },
        { name: "measuredAt", label: "测量时间", type: "datetime-local", required: true },
        { name: "method", label: "测量方式", type: "select", required: true, options: [
          { value: "经皮胆红素（TCB）", label: "经皮胆红素（TCB）" },
          { value: "血清胆红素（TSB）", label: "血清胆红素（TSB）" }] },
        { name: "level", label: "黄疸值 (mg/dL)", type: "number", step: "0.1", required: true },
        { name: "trend", label: "趋势", type: "select", required: true, options: [
          { value: "up", label: "较前上升" }, { value: "flat", label: "基本持平" }, { value: "down", label: "较前下降" }] },
        { name: "feeding", label: "喂养情况（方式/频次/吃奶力度）", type: "textarea" },
        { name: "stool", label: "排泄情况（大便颜色次数/小便）", type: "textarea" },
        { name: "prevPlan", label: "既往观察计划（留空自动带入）", placeholder: "留空则自动带入现行黄疸观察计划" },
        { name: "prevAdvice", label: "既往医生建议（留空自动带入最近巡诊）", placeholder: "留空则自动带入最近一次医生巡诊建议" },
      ]} submitLabel="提交测量并自动分级" />
  );
}

// 护士长：转诊闭环总览面板
export function HeadNurseReferralPanel({ role }: { role: string }) {
  const cases = q(
    `SELECT c.*, r.number, s.baby_name, s.mother_name FROM jaundice_cases c
     JOIN stays s ON s.id=c.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE c.status NOT IN ('routine_resumed','closed')
     ORDER BY c.delayed DESC,
       CASE c.status WHEN 'referral_pending_family' THEN 0 WHEN 'referral_confirmed' THEN 1
        WHEN 'delayed_escalated' THEN 0 WHEN 'coordinating' THEN 2 WHEN 'referred' THEN 3
        WHEN 'at_hospital' THEN 4 WHEN 'returned_pending_review' THEN 5 WHEN 'review_conflict' THEN 0
        ELSE 6 END, c.id DESC`);
  const referrals = cases.filter((c) =>
    ["referral_pending_family", "referral_confirmed", "coordinating", "delayed_escalated", "referred", "at_hospital",
      "returned_pending_review", "review_conflict"].includes(s(c.status)));
  const completed = q(
    `SELECT c.*, r.number, s.baby_name, s.mother_name FROM jaundice_cases c
     JOIN stays s ON s.id=c.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE c.status IN ('routine_resumed','closed') ORDER BY c.updated_at DESC LIMIT 5`);
  return (
    <div>
      <Section title="黄疸转诊闭环（协调 · 延迟升级 · 返中心交接）" tone={referrals.some((c) => num(c.delayed) === 1) ? "tone-red" : ""}>
        {referrals.length === 0 && <div className="empty">暂无转诊中的黄疸案例</div>}
        {referrals.map((c) => (
          <div key={num(c.id)}>
            <div className="muted small">{s(c.number)}房 · 宝宝{s(c.baby_name)}（{s(c.mother_name)}）</div>
            <JaundiceCaseCard c={c} role={role} detailed />
          </div>
        ))}
      </Section>
      {completed.length > 0 && (
        <details>
          <summary className="muted small" style={{ margin: "8px 0" }}>最近已闭环黄疸案例（{completed.length}，含交接与重建结果，供主管追溯）</summary>
          {completed.map((c) => (
            <div key={num(c.id)}>
              <div className="muted small">{s(c.number)}房 · 宝宝{s(c.baby_name)}（{s(c.mother_name)}）</div>
              <JaundiceCaseCard c={c} role={role} detailed />
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

// 家属端：仅展示经医生确认的处理建议 + 转诊确认
export function FamilyJaundicePanel({ stayId }: { stayId: number }) {
  const cases = q("SELECT * FROM jaundice_cases WHERE stay_id=? ORDER BY id DESC", stayId);
  if (!cases.length) return null;
  return (
    <Section title="宝宝黄疸诊疗安排（以儿科医生确认为准）">
      {cases.map((c) => {
        const st = s(c.status);
        if (st === "pending_doctor") {
          return <div key={num(c.id)} className="empty">护理师已上报宝宝黄疸情况，儿科医生确认处理建议后将在此向您同步，请稍候。</div>;
        }
        const inReferral = ["referral_pending_family", "referral_confirmed", "coordinating", "delayed_escalated", "referred", "at_hospital"].includes(st);
        return (
          <div key={num(c.id)} className="card" style={{ boxShadow: "none", border: "1px solid #eee", marginBottom: 10 }}>
            <div className="card-body">
              <div className="small muted">儿科医生 {s(c.doctor_name)} · {dt(c.doctor_confirmed_at)}</div>
              <p style={{ margin: "6px 0" }}><b>医生确认的处理建议：</b>{s(c.doctor_advice)}</p>

              {st === "referral_pending_family" && (
                <div className="tone-red-inner" style={{ padding: 10, borderRadius: 8, background: "#fff6f6", border: "1px solid #f3c9c9" }}>
                  <b>医生建议将宝宝转至外院进一步诊疗，请您确认：</b>
                  <div className="row mt8">
                    <ActionButton action="jaundice.familyRespond" payload={{ caseId: num(c.id), confirm: true }}
                      label="我确认转诊" kind="primary" confirm="确认同意中心安排转诊？" />
                    <DataForm compact action="jaundice.familyRespond" hidden={{ caseId: num(c.id), confirm: false }}
                      fields={[{ name: "riskNote", label: "请填写您的顾虑（中心将留存风险告知，护士长会与您沟通）", type: "textarea", required: true }]}
                      submitLabel="暂不转诊（护士长介入）" />
                  </div>
                </div>
              )}

              {inReferral && st !== "referral_pending_family" && (
                <div className="mt8">
                  <KV items={[
                    ["转诊进度", JAUNDICE_STATUS_LABEL[st] || st],
                    ["车辆", c.vehicle_info ? `${s(c.vehicle_info)}（${VEHICLE_LABEL[s(c.vehicle_status)] || ""}）` : "安排中"],
                    ["陪同人员", s(c.escort_name) || "安排中"],
                    ["目标医院", s(c.target_hospital) || "安排中"],
                  ]} />
                  {num(c.delayed) === 1 && (
                    <div className="tone-red-inner" style={{ padding: 10, borderRadius: 8, background: "#fff6f6", border: "1px solid #f3c9c9" }}>
                      <div className="badge amber">转诊暂未启动，护士长正在跟进。</div>
                      <p className="small" style={{ margin: "6px 0" }}>已留存风险告知：{s(c.risk_note)}</p>
                      {num(c.family_confirmed) === 0 && (
                        <ActionButton action="jaundice.familyRespond" payload={{ caseId: num(c.id), confirm: true, note: "经护士长沟通后同意转诊" }}
                          label="我改主意了，同意转诊" kind="primary" confirm="确认现在同意中心安排转诊？" />
                      )}
                    </div>
                  )}
                </div>
              )}

              {(st === "returned_pending_review" || st === "review_conflict") && (
                <div className="muted small mt8">宝宝已返回中心，儿科医生正结合外院回执为宝宝制定新的观察计划，确认后将在此同步。</div>
              )}
              {st === "routine_resumed" && (
                <div className="mt8">
                  <div className="badge green">已按新计划恢复护理</div>
                  <p className="small" style={{ marginTop: 6 }}><b>医生新建议：</b>{s(c.new_doctor_advice)}</p>
                  <p className="muted small">{s(c.rebuilt_detail)}</p>
                </div>
              )}
              {st === "closed" && <div className="badge green mt8">黄疸观察已结束，宝宝指标稳定。</div>}
            </div>
          </div>
        );
      })}
    </Section>
  );
}
