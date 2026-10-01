// 黄疸分级处置与转诊闭环：服务端展示组件（员工全程面板 + 家属确认视图）
import Link from "next/link";
import { q } from "@/lib/db";
import type { SessionUser } from "@/lib/auth";
import { Section, DataTable, KV, Badge } from "./ui";
import { DataForm, ActionButton } from "./client";
import {
  getJaundiceCaseDetail, listJaundiceCases, listFamilyJaundice,
} from "@/lib/jaundice";
import {
  JAUNDICE_LEVELS, JAUNDICE_STATUSES, JAUNDICE_METHODS, JAUNDICE_TODO_KINDS,
  JAUNDICE_EVENTS, dt, jaundiceLevelClass, jaundiceStatusClass,
} from "@/lib/labels";

type Row = Record<string, unknown>;

const STAFF = ["admin", "head_nurse", "nurse", "matron", "pediatrician"];
const NURSE_ROLES = ["nurse", "matron", "head_nurse", "admin"];

function nurseOptions() {
  return q("SELECT id,name FROM users WHERE active=1 AND role IN ('nurse','matron') ORDER BY role,id")
    .map((u) => ({ value: String(u.id), label: String(u.name) }));
}

// 家属可见的过程事件（隐藏内部分级/升级/备注等未经医生确认的信息）
const FAMILY_EVENTS = new Set([
  "doctor_confirmed", "family_confirmed", "family_declined", "coordinated",
  "vehicle_declined", "departed", "arrived", "returned", "reviewed",
  "plan_rebuilt", "routine_resumed", "closed",
]);

function trendBadge(trend: string) {
  if (trend.includes("升")) return <span className="badge red">{trend}</span>;
  if (trend.includes("降")) return <span className="badge green">{trend}</span>;
  return <span className="badge gray">{trend || "-"}</span>;
}

// ------------------------------------------------------------ 员工全程面板
export function JaundiceCasePanel(props: { caseId: number; user: SessionUser }) {
  const { user } = props;
  const { data: c, measurements, events, todos } = getJaundiceCaseDetail(props.caseId);
  if (!c) return <div className="empty">闭环事件不存在</div>;
  const status = String(c.status);
  const isDoctor = user.role === "pediatrician" || user.role === "admin";
  const isManager = user.role === "head_nurse" || user.role === "admin";
  const isNurse = NURSE_ROLES.includes(user.role);
  const pendingTodos = todos.filter((t) => t.status === "pending");

  const canRemeasure = isNurse && ["reported", "doctor_confirming", "monitoring", "family_declined"].includes(status);
  const canConfirm = isDoctor && ["reported", "doctor_confirming", "monitoring"].includes(status);
  const canCoordinate = isNurse && ["family_confirmed", "coordinating", "upgraded"].includes(status);
  const canDepart = isNurse && ["coordinating", "upgraded", "family_confirmed"].includes(status)
    && c.vehicle_status === "已协调" && c.escort_status === "已协调" && Boolean(c.target_hospital) && Boolean(c.handover_content);
  const canArrive = isNurse && status === "referred" && !c.arrived_at;
  const canReturn = isNurse && status === "referred" && !!c.arrived_at;
  const canReview = isDoctor && ["returned", "conflict_review"].includes(status);
  const canClose = isManager && status === "resolved";

  return (
    <div className="jc-panel">
      <div className="jc-head row">
        <b>{String(c.code)}</b>
        <Badge text={JAUNDICE_LEVELS[String(c.level)] || String(c.level)} cls={jaundiceLevelClass(String(c.level))} />
        <Badge text={JAUNDICE_STATUSES[status] || status} cls={jaundiceStatusClass(status)} />
        {Number(c.escalated_head_nurse) ? <span className="badge red">已升级护士长</span> : null}
        {Number(c.conflict) ? <span className="badge red">外院建议冲突·待复核</span> : null}
        <span className="muted small">更新于 {dt(c.updated_at)}</span>
      </div>

      {c.risk_note ? <div className="jc-risk">⚠ {String(c.risk_note)}</div> : null}

      <KV items={[
        ["最新测量", measurements[0]
          ? <span key="m">{measurements[0].measured_at ? dt(measurements[0].measured_at) : "-"} · {JAUNDICE_METHODS[String(measurements[0].method)] || String(measurements[0].method)}
              <b className={Number(measurements[0].value) >= 12 ? " jc-hi" : ""}> {String(measurements[0].value)}mg/dL</b> {trendBadge(String(measurements[0].trend || ""))}</span>
          : "-"],
        ["医生确认建议", c.advice_confirmed_at
          ? <span key="a"><span className="badge green">已对家属可见</span> {String(c.doctor_advice)}<div className="muted small">{String(c.advice_by_name)} · {dt(c.advice_confirmed_at)}</div></span>
          : <span key="a" className="badge gray">医生尚未确认——护理师不得自行承诺转诊或调整治疗，家属端暂不可见</span>],
        ["转诊指征", c.referral_reason ? String(c.referral_reason) : "-"],
        ["家属决定", c.family_decision === "agree"
          ? <span key="f" className="badge green">已确认转诊（{String(c.family_decision_name)} · {dt(c.family_decision_at)}）</span>
          : c.family_decision === "decline"
            ? <span key="f" className="badge red">家属暂拒（{String(c.family_decision_name)} · {dt(c.family_decision_at)}）</span>
            : <span key="f" className="muted small">{status === "referral_pending_family" ? "等待家属确认" : "-"}</span>],
        ["车辆 / 陪同", <span key="v">{String(c.vehicle || "-")}
          {c.vehicle_status ? <span className={`badge ${c.vehicle_status === "车辆拒绝" ? "red" : "green"}`}>{String(c.vehicle_status)}</span> : null}
          {" / "}{String(c.escort || "-")}
          {c.escort_status ? <span className={`badge ${c.escort_status === "陪同拒绝" ? "red" : "green"}`}>{String(c.escort_status)}</span> : null}</span>],
        ["目标医院 / 交接", <span key="h"><b>{String(c.target_hospital || "-")}</b>
          <div className="muted small">{c.departed_at ? `出发 ${dt(c.departed_at)}` : "未出发"}
            {c.arrived_at ? ` · 到达交接 ${dt(c.arrived_at)}` : ""}</div></span>],
        ["交接材料", c.handover_content
          ? <details key="d"><summary className="muted small">查看中心护理交接材料（{String(c.handover_by_name)}）</summary><div className="jc-handover">{String(c.handover_content)}</div></details>
          : "-"],
        ["外院回执", c.hospital_receipt
          ? <span key="r">{String(c.hospital_receipt)}<div className="muted small">返中心 {dt(c.returned_at)}</div></span>
          : <span key="r" className="muted small">-</span>],
        ["医生复核/新建议", c.review_note
          ? <span key="rv"><span className="badge green">已复核 · 已恢复常规护理 {dt(c.routine_resumed_at)}</span>{String(c.review_note)}<div className="muted small">{String(c.reviewed_by_name)} · {dt(c.reviewed_at)}</div></span>
          : status === "conflict_review" ? <span key="rv" className="badge red">外院建议与原中心计划冲突，必须医生复核后才能恢复常规护理</span> : "-"],
        ["既往观察计划", <details key="p"><summary className="muted small">查看上报时快照</summary><div className="muted small">{String(c.prior_plan)}</div></details>],
      ]} />

      <div className="grid cols-2 jc-cols">
        <div>
          <div className="jc-sub">测量记录（时间 / 方式 / 趋势 / 喂养 / 排泄）</div>
          <DataTable cols={["时间", "方式", "数值", "趋势", "喂养", "大便/小便"]} empty="暂无测量"
            rows={measurements.map((m) => [
              <span key="t" className="small">{dt(m.measured_at)}</span>,
              String(m.method),
              <b key="v" className={Number(m.value) >= 12 ? "jc-hi" : ""}>{String(m.value)}</b>,
              trendBadge(String(m.trend || "")),
              <span key="f" className="small">{String(m.feeding)}</span>,
              <span key="s" className="small">{String(m.stool || "-")} / {String(m.urine || "-")}</span>,
            ])} />
        </div>
        <div>
          <div className="jc-sub">未完成事项（{pendingTodos.length}）</div>
          <DataTable cols={["类型", "事项", "截止", "负责人", "状态"]} empty="无未完成事项"
            rows={todos.map((t) => [
              JAUNDICE_TODO_KINDS[String(t.kind)] || String(t.kind),
              <span key="ti" className="small">{String(t.title)}{t.cancel_reason ? <div className="muted small">取消原因：{String(t.cancel_reason)}</div> : null}</span>,
              <span key="d" className="small">{dt(t.due_at)}</span>,
              String(t.assignee_name || "-"),
              t.status === "pending" ? <span key="s" className="badge amber">待办</span>
                : t.status === "done" ? <span key="s" className="badge green">已完成 {dt(t.done_at)}</span>
                : <span key="s" className="badge gray">已取消</span>,
            ])} />
        </div>
      </div>

      {/* 全程时间线 */}
      <div className="jc-sub">全程时间线（测量分级 → 医生确认 → 家属决定 → 转诊协调 → 返中心复核 → 计划重建）</div>
      <ul className="timeline">
        {events.map((ev) => (
          <li key={String(ev.id)}>
            <span className="t-time">{dt(ev.created_at)}</span>
            <span className="badge blue">{JAUNDICE_EVENTS[String(ev.event_type)] || String(ev.event_type)}</span>
            <b>{String(ev.actor_name)}</b>：{String(ev.detail)}
          </li>
        ))}
      </ul>

      {/* 操作区：严格按角色/状态开放 */}
      <div className="jc-actions">
        {canRemeasure && (
          <details>
            <summary className="muted">护理师：登记加强复测（复测升高将自动退回医生确认，护士不得自行决定转诊）</summary>
            <DataForm compact action="jaundice.remeasure" hidden={{ id: Number(c.id) }}
              fields={[
                { name: "measuredAt", label: "测量时间", type: "datetime-local", required: true },
                { name: "method", label: "测量方式", type: "select", required: true, options: [{ value: "TCB", label: "经皮胆红素 TCB" }, { value: "TSB", label: "血清胆红素 TSB" }] },
                { name: "value", label: "黄疸值(mg/dL)", type: "number", step: "0.1", required: true },
                { name: "trend", label: "趋势（留空自动判断）", type: "select", options: [{ value: "auto", label: "自动判断" }, { value: "上升", label: "上升" }, { value: "持平", label: "持平" }, { value: "下降", label: "下降" }] },
                { name: "feeding", label: "喂养情况", required: true, placeholder: "如 母乳每3小时1次，吃奶有力" },
                { name: "stool", label: "大便情况", placeholder: "次数/颜色" },
                { name: "urine", label: "小便情况", placeholder: "次数/颜色" },
              ]} submitLabel="提交复测" />
          </details>
        )}

        {canConfirm && (
          <details open={!c.advice_confirmed_at}>
            <summary className="muted">儿科医生：当班评估并确认处理建议（确认后才同步家属端）</summary>
            <DataForm compact action="jaundice.doctorConfirm" hidden={{ id: Number(c.id) }}
              fields={[
                { name: "decision", label: "处置决定", type: "select", required: true,
                  options: [{ value: "monitor", label: "加强复测 / 留观（不转诊）" }, { value: "referral", label: "建议转诊" }] },
                { name: "advice", label: "经医生确认的处理建议（家属端唯一可见口径）", type: "textarea", required: true, placeholder: "如：加强喂养、6/12小时复测，达到指征再转诊" },
                { name: "referralReason", label: "转诊指征（决定转诊时必填）", placeholder: "如 TCB≥15，黄染范围扩大" },
                { name: "remeasureTimes", label: "复测时间（可选，每行一个，留空自动排6h/12h/24h）", type: "textarea" },
              ]} submitLabel="医生确认" />
          </details>
        )}

        {canCoordinate && (
          <details open={status === "family_confirmed" || status === "upgraded"}>
            <summary className="muted">转诊协调：车辆 / 陪同人员 / 目标医院 / 中心护理交接（车辆或陪同拒绝将自动升级护士长）</summary>
            <DataForm compact action="jaundice.coordinate" hidden={{ id: Number(c.id) }}
              fields={[
                { name: "vehicleResult", label: "车辆结果", type: "select", options: [{ value: "keep", label: "仅保存信息" }, { value: "ok", label: "已协调到车" }, { value: "declined", label: "车辆拒绝/无车" }] },
                { name: "vehicle", label: "车辆", placeholder: "如 中心合作转运车 / 120 / 备用私家车" },
                { name: "escortResult", label: "陪同结果", type: "select", options: [{ value: "keep", label: "仅保存信息" }, { value: "ok", label: "陪同已确定" }, { value: "declined", label: "无人可陪同" }] },
                { name: "escort", label: "陪同人员", placeholder: "如 李婷（护理师）" },
                { name: "targetHospital", label: "目标医院", placeholder: "如 市儿童医院 新生儿科" },
                { name: "handoverContent", label: "中心护理交接材料", type: "textarea", placeholder: "黄疸记录、喂养排泄记录、接种本/母婴手册、证件复印件、医嘱等" },
                { name: "declineNote", label: "拒绝/延迟原因（出现拒绝时必填）" },
              ]} submitLabel="保存协调信息" />
            {canDepart && (
              <div className="mt8">
                <ActionButton action="jaundice.transport" kind="primary"
                  payload={{ id: Number(c.id), stage: "depart" }}
                  label="登记出发转诊" confirm="确认车辆/陪同/医院/交接材料齐备，宝宝出发？" />
              </div>
            )}
          </details>
        )}

        {canArrive && (
          <details open>
            <summary className="muted">到达外院：登记接收与交接完成</summary>
            <DataForm compact action="jaundice.transport" hidden={{ id: Number(c.id), stage: "arrive" }}
              fields={[
                { name: "at", label: "到达时间", type: "datetime-local" },
                { name: "note", label: "交接说明", placeholder: "如 新生儿科接收，交接材料已签字" },
              ]} submitLabel="登记到达" />
          </details>
        )}

        {canReturn && (
          <details open>
            <summary className="muted">宝宝返回中心：登记外院回执（与原计划冲突将挂起常规护理，待医生复核）</summary>
            <DataForm compact action="jaundice.return" hidden={{ id: Number(c.id) }}
              fields={[
                { name: "returnedAt", label: "返回时间", type: "datetime-local" },
                { name: "hospitalReceipt", label: "外院回执（诊断/光疗/带药/复诊）", type: "textarea", required: true },
                { name: "conflict", label: "外院建议与原中心计划冲突（系统会自动识别喂养冲突，请复核）", type: "checkbox" },
                { name: "conflictDetail", label: "冲突说明", type: "textarea" },
              ]} submitLabel="登记返中心" />
          </details>
        )}

        {canReview && (
          <details open>
            <summary className="muted">儿科医生：复核外院回执与冲突 → 重建观察计划、取消过期提醒、同步护理师排班</summary>
            <DataForm compact action="jaundice.doctorReview" hidden={{ id: Number(c.id) }}
              fields={[
                { name: "reviewNote", label: "医生复核意见与新建议", type: "textarea", required: true, placeholder: "如：混合喂养过渡72h，胆红素稳定后恢复母乳，加强复测" },
                { name: "frequency", label: "新观察计划频次", required: true, placeholder: "如 过渡72h每12h1次，之后每日1次" },
                { name: "assigneeId", label: "负责护理师（同步排班）", type: "select", required: true, options: nurseOptions() },
                { name: "remeasureTimes", label: "复测时间（可选，每行一个，留空自动排4h/12h/24h）", type: "textarea" },
              ]} submitLabel="复核通过并重建计划、恢复常规护理" />
          </details>
        )}

        {canClose && (
          <div className="row">
            <ActionButton action="jaundice.close" kind="primary" payload={{ id: Number(c.id) }}
              label="护理主管核对无误后关闭闭环"
              confirm="将核对全程时间线、交接材料与未完成事项，确认关闭该黄疸处置闭环？" />
            <DataForm compact action="jaundice.note" hidden={{ id: Number(c.id) }}
              fields={[{ name: "note", label: "关闭备注", placeholder: "可选" }]} submitLabel="追加备注" />
          </div>
        )}

        {STAFF.includes(user.role) && !["resolved", "closed"].includes(status) && !canClose && (
          <details>
            <summary className="muted">追加过程备注（内部留痕）</summary>
            <DataForm compact action="jaundice.note" hidden={{ id: Number(c.id) }}
              fields={[{ name: "note", label: "备注内容", type: "textarea", required: true }]} submitLabel="保存备注" />
          </details>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ 房间聚合区块
export function StayJaundiceSection(props: { stayId: number; user: SessionUser; roomNumber: string }) {
  const cases = listJaundiceCases({ stayId: props.stayId });
  const canReport = NURSE_ROLES.includes(props.user.role);
  return (
    <Section title="宝宝黄疸分级处置与转诊闭环" tone={cases.some((c) => ["upgraded", "referral_pending_family", "conflict_review"].includes(String(c.status))) ? "tone-red" : ""}
      extra={<Badge text={`${cases.filter((c) => !["resolved", "closed"].includes(String(c.status))).length} 件进行中`} cls="badge amber" />}>
      {cases.length === 0 && <div className="empty">暂无黄疸处置事件</div>}
      {cases.map((c) => (
        <details key={String(c.id)} className="jc-case" open={!["resolved", "closed"].includes(String(c.status))}>
          <summary>
            <span className="row" style={{ gap: 8 }}>
              <b>{String(c.code)}</b>
              <Badge text={JAUNDICE_LEVELS[String(c.level)] || String(c.level)} cls={jaundiceLevelClass(String(c.level))} />
              <Badge text={JAUNDICE_STATUSES[String(c.status)] || String(c.status)} cls={jaundiceStatusClass(String(c.status))} />
              {Number(c.escalated_head_nurse) ? <span className="badge red">已升级</span> : null}
              <span className="muted small">最新 {String(c.last_method || "TCB")} {String(c.last_value ?? "-")}mg/dL · 待办 {String(c.pending_todos)}</span>
            </span>
          </summary>
          <div className="mt8"><JaundiceCasePanel caseId={Number(c.id)} user={props.user} /></div>
        </details>
      ))}
      {canReport && (
        <details className="mt8">
          <summary className="muted">护理师：测得黄疸值升高，发起分级上报</summary>
          <ReportForm stayId={props.stayId} />
        </details>
      )}
    </Section>
  );
}

export function ReportForm(props: { stayId?: number; stayOptions?: { value: string; label: string }[] }) {
  return (
    <DataForm compact action="jaundice.report" hidden={props.stayId ? { stayId: props.stayId } : {}}
      fields={[
        ...(!props.stayId ? [{ name: "stayId", label: "房间", type: "select" as const, required: true, options: props.stayOptions || [] }] : []),
        { name: "measuredAt", label: "测量时间", type: "datetime-local", required: true },
        { name: "method", label: "测量方式", type: "select", required: true, options: [{ value: "TCB", label: "经皮胆红素 TCB" }, { value: "TSB", label: "血清胆红素 TSB" }] },
        { name: "value", label: "黄疸值(mg/dL)", type: "number", step: "0.1", required: true },
        { name: "trend", label: "趋势（留空自动与上次比较）", type: "select", options: [{ value: "auto", label: "自动判断" }, { value: "上升", label: "上升" }, { value: "持平", label: "持平" }, { value: "下降", label: "下降" }, { value: "首次", label: "首次测量" }] },
        { name: "feeding", label: "喂养情况", required: true, placeholder: "喂养方式/频次/吃奶情况" },
        { name: "stool", label: "大便情况", placeholder: "次数/颜色" },
        { name: "urine", label: "小便情况", placeholder: "次数/颜色" },
        { name: "note", label: "其他观察（精神/皮肤黄染范围等）", type: "textarea" },
      ]} submitLabel="上报并自动分级" />
  );
}

// ------------------------------------------------------------ 家属端视图
export function FamilyJaundiceSection(props: { stayId: number }) {
  const cases = listFamilyJaundice(props.stayId);
  if (!cases.length) return null;
  return (
    <Section title="宝宝黄疸观察与转诊（医生确认信息）">
      {cases.map((c0) => {
        const { data: c, events } = getJaundiceCaseDetail(Number(c0.id));
        if (!c) return null;
        const status = String(c.status);
        return (
          <div key={String(c.id)} className="jc-panel">
            <div className="jc-head row">
              <b>{String(c.code)}</b>
              <Badge text={JAUNDICE_LEVELS[String(c.level)] || ""} cls={jaundiceLevelClass(String(c.level))} />
              <Badge text={JAUNDICE_STATUSES[status] || status} cls={jaundiceStatusClass(status)} />
            </div>
            <div className="jc-advice">
              <div className="muted small">儿科医生确认的处理建议：</div>
              <div>{String(c.doctor_advice)}</div>
              <div className="muted small">{String(c.advice_by_name)} · {dt(c.advice_confirmed_at)}</div>
            </div>
            {c.review_note ? (
              <div className="jc-advice">
                <div className="muted small">返中心后医生新建议：</div>
                <div>{String(c.review_note)}</div>
              </div>
            ) : null}
            {status === "referral_pending_family" && (
              <div className="jc-family-decide">
                <div><b>医生建议将宝宝转上级医院新生儿科评估治疗</b>，中心将在您确认后协调车辆、陪同人员与目标医院，请您确认：</div>
                <div className="muted small">转诊指征：{String(c.referral_reason)}</div>
                <div className="row mt8">
                  <ActionButton action="jaundice.familyDecide" kind="primary"
                    payload={{ id: Number(c.id), decision: "agree", note: "家属端确认转诊" }}
                    label="确认转诊（中心协调车辆与陪同）" confirm="确认同意宝宝转诊？中心将立即协调车辆、陪同人员与目标医院。" />
                  <DataForm compact action="jaundice.familyDecide" hidden={{ id: Number(c.id), decision: "decline" }}
                    fields={[{ name: "note", label: "暂拒原因（中心将继续留观并由护士长再次沟通）", required: true }]}
                    submitLabel="暂拒转诊" />
                </div>
              </div>
            )}
            {status !== "referral_pending_family" && (
              <ul className="timeline">
                {events.filter((e) => FAMILY_EVENTS.has(String(e.event_type))).map((ev) => (
                  <li key={String(ev.id)}>
                    <span className="t-time">{dt(ev.created_at)}</span>
                    <span className="badge blue">{JAUNDICE_EVENTS[String(ev.event_type)] || String(ev.event_type)}</span>
                    {String(ev.event_type) === "vehicle_declined"
                      ? "车辆紧张，中心正在加派资源，请耐心等待"
                      : String(ev.detail)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </Section>
  );
}

// ------------------------------------------------------------ 列表小部件
export function OpenJaundiceList(props: { limit?: number }) {
  const cases = listJaundiceCases({ openOnly: true }).slice(0, props.limit || 20);
  if (!cases.length) return <div className="empty">暂无进行中的黄疸处置事件</div>;
  return (
    <DataTable cols={["闭环", "房间", "宝宝", "分级", "状态", "最新值", "待办", ""]}
      rows={cases.map((c) => [
        String(c.code),
        <Link key="r" href={`/stays/${c.stay_id}`}>{String(c.room_number)}</Link>,
        String(c.baby_name),
        <Badge key="l" text={JAUNDICE_LEVELS[String(c.level)] || ""} cls={jaundiceLevelClass(String(c.level))} />,
        <span key="s" className="row">
          <Badge text={JAUNDICE_STATUSES[String(c.status)] || String(c.status)} cls={jaundiceStatusClass(String(c.status))} />
          {Number(c.escalated_head_nurse) ? <span className="badge red">已升级</span> : null}
        </span>,
        <span key="v" className={Number(c.last_value) >= 15 ? "jc-hi" : ""}>{String(c.last_value ?? "-")} mg/dL</span>,
        Number(c.pending_todos),
        <Link key="go" href={`/stays/${c.stay_id}#jaundice`}>进入处置</Link>,
      ])} />
  );
}

export type { Row };
