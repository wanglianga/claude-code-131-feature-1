// 宝宝黄疸升高「分级处置 + 转诊闭环」业务引擎
// 流程：护理师测量(自动阈值分级) → 儿科医生确认建议 → 家属端仅见确认建议
//   → 医生建议转诊时取得家属确认 → 护士长协调车辆/陪同/目标医院/交接
//   → 车辆或家属拒绝自动升级护士长并保留风险说明 → 出发/到达
//   → 返中心登记外院回执 → 医生复核(冲突必须复核) → 重建观察计划/取消过期提醒/同步排班
import { q, q1, run, now, today } from "./db";
import type { SessionUser } from "./auth";

type Payload = Record<string, unknown>;
type Row = Record<string, unknown>;

function str(p: Payload, k: string, def = ""): string {
  const v = p[k];
  return v === undefined || v === null ? def : String(v).trim();
}
function num(v: unknown): number;
function num(p: Payload, k: string, def?: number): number;
function num(a: unknown, b?: string, def = 0): number {
  if (b !== undefined && a && typeof a === "object") {
    const v = Number((a as Payload)[b]);
    return Number.isFinite(v) ? v : def;
  }
  return Number(a ?? 0);
}
function req(p: Payload, k: string, label: string): string {
  const v = str(p, k);
  if (!v) throw new Error(`请填写${label}`);
  return v;
}

// ---- 阈值分级（经皮胆红素 TCB，mg/dL）----
export const JAUNDICE_THRESHOLDS = { enhanced: 12, doctor_eval: 15, urgent_referral: 18 };

export const GRADES = ["normal", "enhanced", "doctor_eval", "urgent_referral"] as const;
export type Grade = (typeof GRADES)[number];

export function gradeJaundice(level: number): { grade: Grade; severity: string } {
  if (level >= JAUNDICE_THRESHOLDS.urgent_referral) return { grade: "urgent_referral", severity: "critical" };
  if (level >= JAUNDICE_THRESHOLDS.doctor_eval) return { grade: "doctor_eval", severity: "high" };
  if (level >= JAUNDICE_THRESHOLDS.enhanced) return { grade: "enhanced", severity: "medium" };
  return { grade: "normal", severity: "low" };
}
const rank = (g: string) => Math.max(0, GRADES.indexOf(g as Grade));

// 案例状态
export const TERMINAL = ["routine_resumed", "closed"];
const OPEN_CASE_SQL =
  "SELECT * FROM jaundice_cases WHERE stay_id=? AND status NOT IN ('routine_resumed','closed') ORDER BY id DESC LIMIT 1";

function jEvent(caseId: number, stayId: number, user: SessionUser | null, action: string, note: string) {
  run("INSERT INTO jaundice_events(case_id,stay_id,user_id,user_name,action,note) VALUES(?,?,?,?,?,?)",
    caseId, stayId, user ? user.id : null, user ? user.name : "系统", action, note);
}
function audit(stayId: number, user: SessionUser | null, action: string, detail: string) {
  run("INSERT INTO audit_logs(stay_id,actor_id,actor_name,action,detail) VALUES(?,?,?,?,?)",
    stayId, user ? user.id : null, user ? user.name : "系统", action, detail);
}
function touch(caseId: number) {
  run("UPDATE jaundice_cases SET updated_at=? WHERE id=?", now(), caseId);
}
function loadCase(caseId: number): Row {
  const c = q1("SELECT * FROM jaundice_cases WHERE id=?", caseId);
  if (!c) throw new Error("黄疸处置案例不存在");
  return c;
}
function assertStatus(c: Row, allowed: string[]) {
  if (!allowed.includes(String(c.status))) {
    throw new Error(`当前案例状态为「${JAUNDICE_STATUS_LABEL[String(c.status)] || String(c.status)}」，不能执行该操作`);
  }
}
function assertFamilyOnCase(user: SessionUser, c: Row) {
  const ok = q1("SELECT 1 FROM family_links WHERE stay_id=? AND user_id=?", Number(c.stay_id), user.id);
  if (!ok) throw new Error("无权操作该房间的黄疸案例");
}
function firstNurse(): number | null {
  const u = q1("SELECT id FROM users WHERE role='nurse' AND active=1 ORDER BY id LIMIT 1");
  return u ? Number(u.id) : null;
}

// 联动异常工单（与既有 exceptions 体系打通，护理主管可在异常中心看到）
function openException(stayId: number, grade: Grade, level: number, user: SessionUser): number {
  const sev = gradeJaundice(level).severity;
  const title = grade === "urgent_referral"
    ? `宝宝黄疸${level}mg/dL，达紧急转诊阈值`
    : grade === "doctor_eval"
      ? `宝宝黄疸${level}mg/dL，需医生当班评估`
      : `宝宝黄疸升高至${level}mg/dL，需加强复测`;
  const id = run(
    `INSERT INTO exceptions(stay_id,type,title,description,severity,status,raised_by,raised_by_name,assigned_role,synced_head_nurse)
     VALUES(?, 'jaundice', ?, ?, ?, 'open', ?, ?, 'pediatrician', 1)`,
    stayId, title, `黄疸分级处置：${JAUNDICE_GRADE_LABEL[grade]}。`, sev, user.id, user.name);
  run("INSERT INTO exception_events(exception_id,user_id,user_name,action,note) VALUES(?,?,?,?,?)",
    id, user.id, user.name, "created", title);
  return id;
}
function syncException(exceptionId: number | null, patch: { severity?: string; note?: string; user: SessionUser; action?: string }) {
  if (!exceptionId) return;
  if (patch.severity) run("UPDATE exceptions SET severity=?, updated_at=? WHERE id=?", patch.severity, now(), exceptionId);
  if (patch.note) {
    run("INSERT INTO exception_events(exception_id,user_id,user_name,action,note) VALUES(?,?,?,?,?)",
      exceptionId, patch.user.id, patch.user.name, patch.action || "note", patch.note);
  }
}
function resolveException(exceptionId: number | null, user: SessionUser, resolution: string) {
  if (!exceptionId) return;
  run("UPDATE exceptions SET status='resolved', resolution=?, resolved_at=?, updated_at=? WHERE id=?",
    resolution, now(), now(), exceptionId);
  run("INSERT INTO exception_events(exception_id,user_id,user_name,action,note) VALUES(?,?,?,?,?)",
    exceptionId, user.id, user.name, "resolved", resolution);
}

// 自动汇总「既往观察计划与医生建议」，护理师可在表单覆盖
function prevContext(stayId: number): { plan: string; advice: string } {
  const plan = q1(
    `SELECT title,frequency FROM care_plans
     WHERE stay_id=? AND status='active' AND (type='jaundice' OR title LIKE '%黄疸%')
     ORDER BY id DESC LIMIT 1`, stayId);
  const rnd = q1("SELECT advice FROM doctor_rounds WHERE stay_id=? ORDER BY round_date DESC,id DESC LIMIT 1", stayId);
  return {
    plan: plan ? `${String(plan.title)}（${String(plan.frequency || "频次见计划")}）` : "黄疸监测每日2次（09:00/20:00）",
    advice: rnd ? String(rnd.advice || "") : "",
  };
}

// 医生确认后自动生成复测提醒任务（返中心重建时会取消过期/被取代的同类提醒）
function createRetestTask(stayId: number, label: string, at: string, assignee: number | null) {
  run(`INSERT INTO care_tasks(stay_id,plan_id,type,title,scheduled_at,assignee_id,visible_to_family)
    VALUES(?,NULL,'jaundice',?,?,?,0)`, stayId, label, at, assignee);
}

// ============================================================ 动作

// 1. 护理师测量黄疸 → 记录上下文并自动分级
export function measure(user: SessionUser, p: Payload) {
  const stayId = num(p, "stayId");
  const stay = q1("SELECT id,status FROM stays WHERE id=?", stayId);
  if (!stay) throw new Error("订单不存在");
  if (String(stay.status) !== "in_stay") throw new Error("该订单已出所，不能登记黄疸测量");
  const level = num(p, "level", NaN);
  if (!Number.isFinite(level) || level <= 0) throw new Error("请填写有效的黄疸测量值");
  const measuredAt = str(p, "measuredAt") ? str(p, "measuredAt").replace("T", " ") : now();
  const method = str(p, "method", "经皮胆红素（TCB）");
  const trend = str(p, "trend", "flat");
  const feeding = str(p, "feeding");
  const stool = str(p, "stool");
  const auto = prevContext(stayId);
  const prevPlan = str(p, "prevPlan", auto.plan);
  const prevAdvice = str(p, "prevAdvice", auto.advice);
  const { grade, severity } = gradeJaundice(level);

  const existing = q1(OPEN_CASE_SQL, stayId);
  let caseId: number;

  // 首次测量即在正常范围：仅更新观察值，不建立分级处置案例/异常工单
  if (!existing && grade === "normal") {
    run("UPDATE stays SET jaundice_level=?, jaundice_note=? WHERE id=?",
      level, `${method}复测正常范围；喂养：${feeding || "未填"}；排泄：${stool || "未填"}`, stayId);
    audit(stayId, user, "黄疸测量上报", `${method} ${level}mg/dL（${trend}）→ 正常范围，无需分级处置`);
    return { grade: "normal", measuredGrade: "normal", message: `黄疸值 ${level}mg/dL 在正常范围，已记录观察，无需分级处置。` };
  }

  if (!existing) {
    // 新建分级处置案例：先进入「待医生确认」，不对家属展示任何处置承诺
    const exceptionId = openException(stayId, grade, level, user);
    caseId = run(
      `INSERT INTO jaundice_cases(stay_id,exception_id,latest_level,grade,status)
       VALUES(?,?,?,?,'pending_doctor')`,
      stayId, exceptionId, level, grade);
    run(`INSERT INTO jaundice_records(stay_id,case_id,measured_at,method,level,trend,feeding,stool,prev_plan,prev_advice,grade,measured_by,measured_by_name)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      stayId, caseId, measuredAt, method, level, trend, feeding, stool, prevPlan, prevAdvice,
      grade, user.id, user.name);
    jEvent(caseId, stayId, user, "created",
      `建立黄疸分级处置案例。测量：${method} ${level}mg/dL，趋势${TREND_LABEL[trend] || trend}；喂养：${feeding || "未填"}；排泄：${stool || "未填"}。既往计划：${prevPlan}；既往医嘱：${prevAdvice || "无"}。`);
    jEvent(caseId, stayId, user, "measured",
      `系统按阈值分级：${JAUNDICE_GRADE_LABEL[grade]}，已同步儿科医生与护士长。`);
    audit(stayId, user, "黄疸测量上报", `${method} ${level}mg/dL（${trend}）→ ${JAUNDICE_GRADE_LABEL[grade]}`);
  } else {
    caseId = Number(existing.id);
    run(`INSERT INTO jaundice_records(stay_id,case_id,measured_at,method,level,trend,feeding,stool,prev_plan,prev_advice,grade,measured_by,measured_by_name)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      stayId, caseId, measuredAt, method, level, trend, feeding, stool, prevPlan, prevAdvice,
      grade, user.id, user.name);
    jEvent(caseId, stayId, user, "measured",
      `复测：${method} ${level}mg/dL（${TREND_LABEL[trend] || trend}），喂养：${feeding || "未填"}，排泄：${stool || "未填"}。系统分级：${JAUNDICE_GRADE_LABEL[grade]}。`);
    run("UPDATE jaundice_cases SET latest_level=? WHERE id=?", level, caseId);
    // 已确认的非转诊案例，测量值跨档升高 → 退回医生重新确认
    if (String(existing.status) === "doctor_confirmed" && rank(grade) > rank(String(existing.grade))) {
      run("UPDATE jaundice_cases SET grade=?, status='pending_doctor', doctor_decision='', doctor_advice='', doctor_confirmed_at=NULL, updated_at=? WHERE id=?",
        grade, now(), caseId);
      jEvent(caseId, stayId, user, "escalated",
        `复测值跨档升高至 ${level}mg/dL（${JAUNDICE_GRADE_LABEL[grade]}），原确认建议失效，需儿科医生再次确认。`);
      syncException(Number(existing.exception_id), { severity, note: `黄疸复测跨档升高至${level}mg/dL，需医生再次确认。`, user });
    } else if (rank(grade) > rank(String(existing.grade))) {
      run("UPDATE jaundice_cases SET grade=?, updated_at=? WHERE id=?", grade, now(), caseId);
    }
    audit(stayId, user, "黄疸复测上报", `${method} ${level}mg/dL（${trend}）`);
    touch(caseId);
  }

  const tip = grade === "normal"
    ? "复测已回落至正常范围，仍须由儿科医生确认后方可关闭观察。"
    : "处置建议须经儿科医生确认后方可告知家属；确认前不得自行承诺转诊或调整治疗说明。";
  const showGrade = grade === "normal" ? "normal" : grade;
  return { id: caseId, grade: showGrade, measuredGrade: grade, message: `已记录并分级为「${JAUNDICE_GRADE_LABEL[showGrade]}」。${tip}` };
}

// 2. 儿科医生确认处理建议（家属端仅在此之后可见）
export function doctorConfirm(user: SessionUser, p: Payload) {
  const c = loadCase(num(p, "caseId"));
  assertStatus(c, ["pending_doctor", "doctor_confirmed"]);
  const decision = req(p, "decision", "处置决定");
  if (!["enhanced_retest", "doctor_eval", "referral"].includes(decision)) throw new Error("非法处置决定");
  const advice = req(p, "advice", "给家属/护理的处理建议");
  const caseId = Number(c.id);
  const stayId = Number(c.stay_id);

  let nextStatus = "doctor_confirmed";
  let note = `医生确认：${DECISION_LABEL[decision]}。建议：${advice}`;
  if (decision === "referral") {
    nextStatus = "referral_pending_family";
    note += " 需取得家属确认后方可启动转诊协调。";
  }
  run(`UPDATE jaundice_cases SET doctor_id=?, doctor_name=?, doctor_decision=?, doctor_advice=?,
       doctor_confirmed_at=?, status=?, grade=?, updated_at=? WHERE id=?`,
    user.id, user.name, decision, advice, now(), nextStatus,
    decision === "referral" ? "urgent_referral" : decision === "doctor_eval" ? "doctor_eval" : String(c.grade),
    now(), caseId);
  jEvent(caseId, stayId, user, "doctor_confirmed", note);
  syncException(Number(c.exception_id), {
    severity: decision === "referral" ? "critical" : decision === "doctor_eval" ? "high" : "medium",
    note, user, action: "accepted",
  });

  // 非转诊：自动下达加强复测/当班评估提醒任务
  if (decision !== "referral") {
    const assignee = firstNurse();
    const at = str(p, "retestAt") ? str(p, "retestAt").replace("T", " ") : `${today()} 16:00`;
    createRetestTask(stayId, decision === "doctor_eval" ? "医生当班评估·黄疸复测（医生要求）" : "黄疸加强复测（医生要求）", at, assignee);
    jEvent(caseId, stayId, user, "reminder", `已向护理师排班下发 ${at} 黄疸复测提醒。`);
    // 医生确认的建议同步给家属（仅 staff→family 消息）
    run("INSERT INTO messages(stay_id,from_user_id,from_name,from_role,audience,content) VALUES(?,?,?,?,?,?)",
      stayId, user.id, user.name, "pediatrician", "family",
      `【宝宝黄疸·医生建议】${advice}（请按护理师安排配合复测）`);
  } else {
    run("INSERT INTO messages(stay_id,from_user_id,from_name,from_role,audience,content) VALUES(?,?,?,?,?,?)",
      stayId, user.id, user.name, "pediatrician", "family",
      `【宝宝黄疸·转诊建议】${advice} 请在家属端确认是否转诊，以便中心立即安排车辆与陪同。`);
  }
  audit(stayId, user, "黄疸医生确认", `${DECISION_LABEL[decision]}：${advice.slice(0, 60)}`);
  touch(caseId);
  return { message: `已确认「${DECISION_LABEL[decision]}」，建议将按规则同步。` };
}

// 3. 家属确认/拒绝转诊（仅在医生建议转诊后开放；护士长介入沟通后家属可在此改主意重新确认）
export function familyRespond(user: SessionUser, p: Payload) {
  const c = loadCase(num(p, "caseId"));
  assertFamilyOnCase(user, c);
  assertStatus(c, ["referral_pending_family", "delayed_escalated"]);
  if (String(c.doctor_decision) !== "referral") throw new Error("医生尚未建议转诊，家属端不能确认转诊");
  const caseId = Number(c.id);
  const stayId = Number(c.stay_id);
  const accept = p.confirm === true || p.confirm === "true" || num(p, "confirm") === 1;

  if (accept) {
    run("UPDATE jaundice_cases SET family_confirmed=1, family_confirmed_by=?, family_confirmed_at=?, family_response_note=?, delayed=0, status='referral_confirmed', updated_at=? WHERE id=?",
      user.id, now(), str(p, "note") || (num(c.family_confirmed) ? "家属经护士长沟通后确认转诊" : "家属确认转诊"), now(), caseId);
    jEvent(caseId, stayId, user, "family_confirmed",
      num(c.family_confirmed) ? "经护士长沟通，家属重新确认转诊，等待协调车辆/陪同/目标医院。" : "家属确认转诊，等待护士长协调车辆/陪同/目标医院。");
    audit(stayId, user, "家属确认转诊", str(p, "note") || "家属确认");
    return { message: "已确认转诊，中心将立即安排车辆与陪同人员。" };
  }
  // 家属拒绝 → 转诊延迟，自动升级护士长并保留风险说明
  const risk = req(p, "riskNote", "拒绝转诊的风险告知与说明");
  run(`UPDATE jaundice_cases SET family_confirmed=0, family_response_note=?, delayed=1, delay_reason='家属拒绝转诊',
       escalated_headnurse=1, escalated_at=?, risk_note=?, status='delayed_escalated', updated_at=? WHERE id=?`,
    str(p, "note") || "家属拒绝转诊", now(), risk, now(), caseId);
  jEvent(caseId, stayId, user, "family_declined", `家属暂拒转诊。风险说明留存：${risk}`);
  jEvent(caseId, stayId, null, "escalated", "因家属拒绝导致转诊延迟，已自动升级护士长介入沟通与风险告知。");
  syncException(Number(c.exception_id), { severity: "critical", note: `家属拒绝转诊，已升级护士长。风险说明：${risk}`, user, action: "note" });
  run("UPDATE exceptions SET severity='critical', synced_head_nurse=1, updated_at=? WHERE id=?", now(), Number(c.exception_id));
  audit(stayId, user, "转诊延迟升级", "家属拒绝转诊 → 自动升级护士长，风险说明已留存");
  return { message: "已记录您的决定。因涉及宝宝风险，护士长将尽快与您沟通，风险说明已留存。" };
}

// 4. 护士长协调车辆/陪同/目标医院/交接
export function coordinate(user: SessionUser, p: Payload) {
  const c = loadCase(num(p, "caseId"));
  assertStatus(c, ["referral_confirmed", "coordinating", "delayed_escalated"]);
  if (num(c.family_confirmed) !== 1) {
    throw new Error("须先取得家属对转诊的明确确认，护士长方可协调车辆/陪同/目标医院");
  }
  const vehicle = req(p, "vehicleInfo", "车辆安排");
  const target = req(p, "targetHospital", "目标医院");
  const escortName = req(p, "escortName", "陪同人员");
  const handoff = str(p, "handoff");
  const caseId = Number(c.id);
  const stayId = Number(c.stay_id);
  const escortId = num(p, "escortId");
  const wasDelayed = String(c.status) === "delayed_escalated";
  run(`UPDATE jaundice_cases SET vehicle_status='arranged', vehicle_info=?, escort_id=?, escort_name=?,
       target_hospital=?, handoff=?, coordinated_by=?, coordinated_by_name=?, coordinated_at=?,
       status='coordinating', updated_at=? WHERE id=?`,
    vehicle, escortId || null, escortName, target, handoff, user.id, user.name, now(), now(), caseId);
  jEvent(caseId, stayId, user, "coordinated",
    `转诊协调完成：车辆「${vehicle}」；陪同 ${escortName}；目标医院 ${target}；中心护理交接：${handoff || "见交接单"}。`);
  if (wasDelayed) jEvent(caseId, stayId, user, "delay_resolved", "此前转诊延迟事项已协调到位，升级事项闭环（风险说明保留备查）。");
  run("INSERT INTO messages(stay_id,from_user_id,from_name,from_role,audience,content) VALUES(?,?,?,?,?,?)",
    stayId, user.id, user.name, "head_nurse", "family",
    `【转诊安排】车辆：${vehicle}；陪同：${escortName}；目标医院：${target}。请做好出发准备。`);
  audit(stayId, user, "转诊协调", `车辆：${vehicle}；陪同：${escortName}；医院：${target}`);
  return { message: "转诊已协调完成，可安排出发。" };
}

// 5. 车辆/其他原因导致转诊延迟 → 自动升级护士长 + 风险说明
export function reportDelay(user: SessionUser, p: Payload) {
  const c = loadCase(num(p, "caseId"));
  assertStatus(c, ["referral_confirmed", "coordinating", "delayed_escalated"]);
  const reasonType = str(p, "reasonType", "vehicle_declined");
  const reason = req(p, "reason", "延迟原因");
  const risk = req(p, "riskNote", "风险说明");
  const caseId = Number(c.id);
  const stayId = Number(c.stay_id);
  const label = reasonType === "family_declined" ? "家属拒绝/临时变卦" : reasonType === "vehicle_declined" ? "车辆无法安排/拒绝" : "其他";
  run(`UPDATE jaundice_cases SET vehicle_status=CASE WHEN ?='vehicle_declined' THEN 'refused' ELSE vehicle_status END,
       delayed=1, delay_reason=?, escalated_headnurse=1, escalated_at=?, risk_note=?,
       status='delayed_escalated', updated_at=? WHERE id=?`,
    reasonType, `${label}：${reason}`, now(), risk, now(), caseId);
  jEvent(caseId, stayId, user, "delay", `${label}：${reason}。风险说明：${risk}`);
  jEvent(caseId, stayId, null, "escalated", "转诊延迟，已自动升级护士长督办。");
  syncException(Number(c.exception_id), { severity: "critical", note: `转诊延迟（${label}）：${reason}；风险说明：${risk}`, user, action: "note" });
  run("UPDATE exceptions SET severity='critical', synced_head_nurse=1, updated_at=? WHERE id=?", now(), Number(c.exception_id));
  audit(stayId, user, "转诊延迟升级", `${label}：${reason}`);
  return { message: "转诊延迟已登记并自动升级护士长，风险说明已留存。" };
}

// 6. 出发 / 7. 到达
export function depart(user: SessionUser, p: Payload) {
  const c = loadCase(num(p, "caseId"));
  assertStatus(c, ["coordinating", "referral_confirmed"]);
  if (!String(c.vehicle_info || "") || !String(c.target_hospital || "")) {
    throw new Error("请先完成车辆与目标医院协调再出发");
  }
  const caseId = Number(c.id);
  const stayId = Number(c.stay_id);
  run("UPDATE jaundice_cases SET status='referred', vehicle_status='enroute', departed_at=?, updated_at=? WHERE id=?",
    now(), now(), caseId);
  jEvent(caseId, stayId, user, "departed", `宝宝由${c.escort_name || "陪同人员"}陪同出发，送往${c.target_hospital}。`);
  audit(stayId, user, "转诊出发", `前往 ${c.target_hospital}`);
  return { message: "已登记出发。" };
}
export function arrive(user: SessionUser, p: Payload) {
  const c = loadCase(num(p, "caseId"));
  assertStatus(c, ["referred"]);
  const caseId = Number(c.id);
  const stayId = Number(c.stay_id);
  const note = str(p, "note");
  run("UPDATE jaundice_cases SET status='at_hospital', vehicle_status='arrived', arrived_at=?, updated_at=? WHERE id=?",
    now(), now(), caseId);
  jEvent(caseId, stayId, user, "arrived", `宝宝已抵达${c.target_hospital}并交接。${note ? "交接备注：" + note : ""}`);
  audit(stayId, user, "转诊到达", `抵达 ${c.target_hospital}`);
  return { message: "已登记到达外院。" };
}

// 8. 宝宝返中心：登记外院回执与外院建议，判断是否与原计划冲突
export function returnCenter(user: SessionUser, p: Payload) {
  const c = loadCase(num(p, "caseId"));
  assertStatus(c, ["at_hospital", "referred"]);
  const receipt = req(p, "externalReceipt", "外院回执（诊断/处置）");
  const externalAdvice = req(p, "externalAdvice", "外院建议");
  const hasConflict = p.conflict === true || p.conflict === "true" || num(p, "conflict") === 1;
  const conflictDetail = str(p, "conflictDetail");
  if (hasConflict && !conflictDetail) throw new Error("标记计划冲突时必须说明冲突点");
  const caseId = Number(c.id);
  const stayId = Number(c.stay_id);
  const status = hasConflict ? "review_conflict" : "returned_pending_review";
  run(`UPDATE jaundice_cases SET status=?, returned_at=?, external_receipt=?, external_advice=?,
       plan_conflict=?, conflict_detail=?, updated_at=? WHERE id=?`,
    status, now(), receipt, externalAdvice, hasConflict ? 1 : 0, conflictDetail, now(), caseId);
  jEvent(caseId, stayId, user, "returned",
    `宝宝已返中心。外院回执：${receipt}；外院建议：${externalAdvice}。${hasConflict ? "与原中心观察计划存在冲突，须医生复核后方可恢复常规护理。" : "待医生依据回执复核并重建观察计划。"}`);
  audit(stayId, user, "转诊返中心", `回执：${receipt.slice(0, 60)}${hasConflict ? "（计划冲突待复核）" : ""}`);
  return { message: hasConflict ? "已登记返中心，检测到计划冲突，必须由医生复核后恢复常规护理。" : "已登记返中心，等待医生复核并重建观察计划。" };
}

// 9. 医生复核外院回执 → 重建观察计划 / 取消过期提醒 / 同步护理师排班 → 恢复常规护理
export function doctorResume(user: SessionUser, p: Payload) {
  const c = loadCase(num(p, "caseId"));
  assertStatus(c, ["returned_pending_review", "review_conflict"]);
  if (String(c.status) === "review_conflict" && !(p.conflictResolved === true || p.conflictResolved === "true" || num(p, "conflictResolved") === 1)) {
    throw new Error("外院建议与原中心计划冲突，须医生逐项复核确认后才能恢复常规护理");
  }
  const newAdvice = req(p, "newAdvice", "医生新建议");
  const frequency = str(p, "frequency", "每日2次");
  const caseId = Number(c.id);
  const stayId = Number(c.stay_id);
  const assignee = num(p, "assigneeId") || firstNurse();

  // 9.1 取消被取代/过期的黄疸复测提醒
  const old = q("SELECT id FROM care_tasks WHERE stay_id=? AND type='jaundice' AND status='pending'", stayId);
  for (const t of old) run("UPDATE care_tasks SET status='cancelled' WHERE id=?", Number(t.id));
  const cancelled = old.length;

  // 9.2 重建观察计划
  const planId = run("INSERT INTO care_plans(stay_id,type,title,frequency,assignee_id,note) VALUES(?,?,?,?,?,?)",
    stayId, "jaundice", `黄疸返中心观察计划（案例#${caseId}）`, frequency, assignee,
    `依据外院回执与医生 ${now().slice(0, 10)} 复核重建：${newAdvice}`);

  // 9.3 按排班时间生成新的复测任务（同步护理师排班）
  const times = parsePlanTimes(str(p, "planTimes"));
  for (const at of times) {
    run(`INSERT INTO care_tasks(stay_id,plan_id,type,title,scheduled_at,assignee_id,visible_to_family)
      VALUES(?,?,'jaundice',?, ?, ?, 1)`,
      stayId, planId, "黄疸复测（返中心观察计划）", at, assignee);
  }
  const assigneeName = assignee ? String(q1("SELECT name FROM users WHERE id=?", assignee)?.name || "护理师") : "护理师";
  const detail = `取消过期/被取代黄疸提醒${cancelled}项；重建观察计划（${frequency}），下发复测任务${times.length}项至${assigneeName}排班。`;

  run(`UPDATE jaundice_cases SET status='routine_resumed', routine_resumed=1, reviewed_by=?, reviewed_by_name=?,
       reviewed_at=?, new_doctor_advice=?, plan_rebuilt=1, rebuilt_at=?, rebuilt_detail=?,
       cancelled_reminders=?, schedule_synced=1, updated_at=? WHERE id=?`,
    user.id, user.name, now(), newAdvice, now(), detail, cancelled, now(), caseId);
  jEvent(caseId, stayId, user, "reviewed", `医生复核外院回执与建议，冲突已按医嘱处理。新建议：${newAdvice}`);
  jEvent(caseId, stayId, user, "plan_rebuilt", detail);
  jEvent(caseId, stayId, user, "routine_resumed", "观察计划已重建，护理师排班已同步，恢复常规护理。");
  run("INSERT INTO messages(stay_id,from_user_id,from_name,from_role,audience,content) VALUES(?,?,?,?,?,?)",
    stayId, user.id, user.name, "pediatrician", "family",
    `【宝宝返中心·新观察计划】${newAdvice} 已为宝宝重新安排黄疸复测，请安心配合。`);
  resolveException(Number(c.exception_id), user, `转诊闭环完成：${detail} 医生新建议：${newAdvice}`);
  audit(stayId, user, "黄疸计划重建", detail);
  return { message: `已复核并重建观察计划：取消${cancelled}项过期提醒，下发${times.length}项复测任务至${assigneeName}，恢复常规护理。` };
}

// 10. 非转诊案例（加强复测/当班评估）由医生确认安全后关闭
export function closeCase(user: SessionUser, p: Payload) {
  const c = loadCase(num(p, "caseId"));
  assertStatus(c, ["doctor_confirmed", "pending_doctor"]);
  if (["referral_pending_family", "referral_confirmed", "coordinating", "referred", "at_hospital"].includes(String(c.status))) {
    throw new Error("转诊流程中的案例不能直接关闭");
  }
  const note = req(p, "note", "关闭说明");
  const caseId = Number(c.id);
  const stayId = Number(c.stay_id);
  run("UPDATE jaundice_cases SET status='closed', updated_at=? WHERE id=?", now(), caseId);
  jEvent(caseId, stayId, user, "closed", `医生关闭观察：${note}`);
  resolveException(Number(c.exception_id), user, `复测稳定，医生关闭黄疸观察：${note}`);
  audit(stayId, user, "黄疸观察关闭", note);
  return { message: "黄疸观察已关闭。" };
}

// 解析排班时间：支持 "YYYY-MM-DD HH:mm"、"YYYY-MM-DDTHH:mm"、"MM-DD HH:mm"
function parsePlanTimes(raw: string): string[] {
  const year = today().slice(0, 4);
  const out: string[] = [];
  for (let line of raw.split(/[\n;；]+/)) {
    line = line.trim().replace("T", " ");
    if (!line) continue;
    if (/^\d{2}-\d{2}\s+\d{1,2}:\d{2}$/.test(line)) line = `${year}-${line}`;
    if (/^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}$/.test(line)) out.push(line);
  }
  if (out.length === 0) {
    out.push(`${today()} 16:00`, `${today()} 20:00`);
  }
  return out.slice(0, 10);
}

// ============================================================ 展示字典
export const JAUNDICE_GRADE_LABEL: Record<string, string> = {
  normal: "复测正常",
  enhanced: "加强复测",
  doctor_eval: "医生当班评估",
  urgent_referral: "紧急转诊",
};
export const JAUNDICE_STATUS_LABEL: Record<string, string> = {
  pending_doctor: "待医生确认",
  doctor_confirmed: "医生已确认（加强观察）",
  referral_pending_family: "待家属确认转诊",
  referral_confirmed: "家属已确认·待协调",
  coordinating: "转诊协调中",
  delayed_escalated: "转诊延迟·已升级护士长",
  referred: "已转诊（在途）",
  at_hospital: "已送达外院",
  returned_pending_review: "已返中心·待医生复核",
  review_conflict: "计划冲突·待医生复核",
  routine_resumed: "已恢复常规护理",
  closed: "已关闭",
};
export const DECISION_LABEL: Record<string, string> = {
  enhanced_retest: "加强复测",
  doctor_eval: "医生当班评估",
  referral: "建议转诊",
};
export const TREND_LABEL: Record<string, string> = {
  up: "上升",
  down: "下降",
  flat: "持平",
};
export const VEHICLE_LABEL: Record<string, string> = {
  none: "未安排",
  arranged: "已安排",
  enroute: "在途",
  arrived: "已到达",
  refused: "车辆拒绝/无法安排",
};
export function jaundiceStatusClass(status: string): string {
  switch (status) {
    case "pending_doctor":
    case "referral_pending_family":
    case "delayed_escalated":
    case "review_conflict":
      return "badge red";
    case "referral_confirmed":
    case "coordinating":
    case "returned_pending_review":
      return "badge amber";
    case "referred":
      return "badge amber";
    case "at_hospital":
      return "badge blue";
    case "doctor_confirmed":
    case "routine_resumed":
      return "badge green";
    default:
      return "badge gray";
  }
}
