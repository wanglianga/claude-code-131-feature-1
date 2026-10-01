// 宝宝黄疸升高分级处置与转诊闭环：领域逻辑 + 业务动作
// 闭环：测量上报 → 阈值分级（加强复测/医生当班评估/紧急转诊）→ 医生确认（家属端仅展示确认后的建议）
//   → 家属确认转诊 → 车辆/陪同/目标医院/交接协调（拒绝即升级护士长并留风险说明）
//   → 转诊外院 → 返中心登记回执 → 冲突则医生复核 → 重建观察计划/取消过期提醒/同步排班 → 恢复常规护理
import { q, q1, run, now } from "./db";
import type { SessionUser } from "./auth";
import { audit, createException } from "./actions";

type Payload = Record<string, unknown>;
type Row = Record<string, unknown>;
type Handler = (user: SessionUser, p: Payload) => unknown;

function str(p: Payload, k: string, def = ""): string {
  const v = p[k];
  return v === undefined || v === null ? def : String(v).trim();
}
function num(p: Payload, k: string, def = 0): number {
  const v = Number(p[k]);
  return Number.isFinite(v) ? v : def;
}
function bool(p: Payload, k: string): boolean {
  return p[k] === true || p[k] === "true" || num(p, k) === 1;
}
function req(p: Payload, k: string, label: string): string {
  const v = str(p, k);
  if (!v) throw new Error(`请填写${label}`);
  return v;
}
function pad(n: number) { return String(n).padStart(2, "0"); }
function fmt(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function plusHours(base: string, hours: number): string {
  const d = new Date(base.replace(" ", "T"));
  d.setHours(d.getHours() + hours);
  return fmt(d);
}
// datetime-local（YYYY-MM-DDTHH:MM）→ 库内统一格式（YYYY-MM-DD HH:MM[:SS]）
function toLocal(s: string): string {
  const v = s.trim().replace("T", " ");
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v) ? `${v}:00` : v;
}

// ---------------------------------------------------------------- 阈值分级
// 单位 mg/dL；TCB=经皮胆红素，TSB=血清胆红素
export type TriageLevel = "enhanced" | "doctor" | "urgent";
export function triageJaundice(method: string, value: number, trendUp: boolean): { level: TriageLevel; reason: string; elevated: boolean } {
  const m = method.toUpperCase();
  if (m === "TSB") {
    if (value >= 18) return { level: "urgent", reason: `血清胆红素(TSB) ${value}mg/dL ≥18，达到紧急转诊光疗指征`, elevated: true };
    if (value >= 15) return { level: "doctor", reason: `TSB ${value}mg/dL 处于 15–18 区间，须医生当班评估`, elevated: true };
    if (value >= 12 && trendUp) return { level: "enhanced", reason: `TSB ${value}mg/dL 且呈上升趋势，启动加强复测`, elevated: true };
    return { level: "enhanced", reason: `TSB ${value}mg/dL，暂按常规观察`, elevated: false };
  }
  if (value >= 15) return { level: "urgent", reason: `经皮胆红素(TCB) ${value}mg/dL ≥15，达到紧急转诊光疗指征`, elevated: true };
  if (value >= 12) return { level: "doctor", reason: `TCB ${value}mg/dL 处于 12–15 区间，须医生当班评估`, elevated: true };
  if (value >= 10 && trendUp) return { level: "enhanced", reason: `TCB ${value}mg/dL 且呈上升趋势，启动加强复测`, elevated: true };
  return { level: "enhanced", reason: `TCB ${value}mg/dL，暂按常规观察`, elevated: false };
}

// ---------------------------------------------------------------- 基础封装
function getCase(id: number): Row {
  const c = q1("SELECT * FROM jaundice_cases WHERE id=?", id);
  if (!c) throw new Error("黄疸处置事件不存在");
  return c;
}
function addEvent(c: Row, type: string, user: SessionUser | null, detail: string, at?: string) {
  run("INSERT INTO jaundice_events(case_id,stay_id,event_type,actor_id,actor_name,actor_role,detail,created_at) VALUES(?,?,?,?,?,?,?,COALESCE(?,datetime('now','localtime')))",
    Number(c.id), Number(c.stay_id), type, user ? user.id : null,
    user ? user.name : "系统", user ? user.role : "system", detail, at || null);
}
function addTodo(c: Row, kind: string, title: string, due: string, assigneeId: number | null, assigneeName: string): number {
  return run("INSERT INTO jaundice_todos(case_id,stay_id,kind,title,due_at,assignee_id,assignee_name) VALUES(?,?,?,?,?,?,?)",
    Number(c.id), Number(c.stay_id), kind, title, due, assigneeId, assigneeName);
}
function cancelTodos(caseId: number, reason: string, onlyOverdue = false) {
  const rows = onlyOverdue
    ? q("SELECT * FROM jaundice_todos WHERE case_id=? AND status='pending' AND due_at<=?", caseId, now())
    : q("SELECT * FROM jaundice_todos WHERE case_id=? AND status='pending'", caseId);
  for (const t of rows) {
    run("UPDATE jaundice_todos SET status='cancelled', cancel_reason=? WHERE id=?", reason, Number(t.id));
  }
  return rows.length;
}
function latestMeasurement(stayId: number, excludeCaseId?: number): Row | undefined {
  // 优先取本宝宝既往测量（含历史事件），用于趋势自动判断
  const rows = excludeCaseId
    ? q(`SELECT m.* FROM jaundice_measurements m
         JOIN jaundice_cases c ON c.id=m.case_id
         WHERE m.stay_id=? AND m.case_id<>?
         ORDER BY m.measured_at DESC, m.id DESC LIMIT 1`, stayId, excludeCaseId)
    : q(`SELECT m.* FROM jaundice_measurements m
         JOIN jaundice_cases c ON c.id=m.case_id
         WHERE m.stay_id=?
         ORDER BY m.measured_at DESC, m.id DESC LIMIT 1`, stayId);
  return rows[0];
}
function snapshotPriorPlan(stayId: number): string {
  const plans = q("SELECT type,title,frequency FROM care_plans WHERE stay_id=? AND status='active' ORDER BY id", stayId);
  const lines = plans
    .filter((p) => ["jaundice_obs", "rounds", "baby_bath"].includes(String(p.type)))
    .map((p) => `${String(p.title)}（${String(p.frequency || "按需")}）`);
  const rnd = q1("SELECT advice FROM doctor_rounds WHERE stay_id=? ORDER BY round_date DESC, id DESC LIMIT 1", stayId);
  if (rnd?.advice) lines.push(`既往医生巡诊建议：${String(rnd.advice)}`);
  return "既往观察计划：" + (lines.length ? lines.join("；") : "常规护理（每日黄疸观察1次，异常即报儿科医生）");
}
function touchCase(caseId: number, patch: string, params: (string | number | null)[]) {
  run(`UPDATE jaundice_cases SET ${patch}, updated_at=? WHERE id=?`, ...params, now(), caseId);
}
function linkException(stayId: number, code: string): void {
  // 与既有异常工单中心联动：关闭与本闭环关联的黄疸工单
  const ex = q1("SELECT id FROM exceptions WHERE stay_id=? AND type='jaundice' AND status IN ('open','processing') AND description LIKE ?",
    stayId, `%${code}%`);
  if (ex) {
    run("UPDATE exceptions SET status='resolved', resolution=?, resolved_at=?, updated_at=? WHERE id=?",
      "黄疸分级处置闭环已完成（见转诊闭环时间线）", now(), now(), Number(ex.id));
  }
}
function parseTimes(text: string, fallback: string[]): string[] {
  const lines = text.split(/[\n;；]+/).map((s) => s.trim()).filter(Boolean);
  return lines.length ? lines : fallback;
}

// ---------------------------------------------------------------- actions
export const JAUNDICE_ACTIONS: Record<string, { roles: string[]; run: Handler }> = {
  // 护士测得黄疸升高：记录测量时间/方式/趋势/喂养/排泄 + 既往观察计划，平台按阈值分级
  "jaundice.report": {
    roles: ["nurse", "matron", "head_nurse", "admin"],
    run(user, p) {
      const stayId = num(p, "stayId");
      const stay = q1("SELECT * FROM stays WHERE id=? AND status='in_stay'", stayId);
      if (!stay) throw new Error("订单不存在或已出所");
      const method = str(p, "method", "TCB").toUpperCase();
      if (!["TCB", "TSB"].includes(method)) throw new Error("测量方式须为 TCB 或 TSB");
      const value = num(p, "value", -1);
      if (value <= 0) throw new Error("请填写有效的黄疸测量值");
      let trend = str(p, "trend");
      const prev = latestMeasurement(stayId);
      if (!trend || trend === "auto") trend = prev ? (value > Number(prev.value) ? "上升" : value < Number(prev.value) ? "下降" : "持平") : "首次";
      const trendUp = trend.includes("升");
      const triage = triageJaundice(method, value, trendUp);
      if (!triage.elevated) {
        // 数值平稳：仅更新档案，不启动处置闭环
        run("UPDATE stays SET jaundice_level=?, jaundice_note=? WHERE id=?", value, str(p, "note", "黄疸常规观察，数值平稳"), stayId);
        audit(stayId, user, "黄疸测量", `${method} ${value}mg/dL（${trend}），数值平稳未启动分级处置`);
        return { message: `${method} ${value}mg/dL，数值平稳，按常规观察即可，未启动分级处置` };
      }
      const measuredAt = str(p, "measuredAt") ? toLocal(str(p, "measuredAt")) : now();
      const feeding = req(p, "feeding", "喂养情况");
      const baseCode = `JC-${measuredAt.slice(0, 10).replaceAll("-", "")}-${String(stay.code || "").split("-").pop() || stayId}`;
      const status = triage.level === "enhanced" ? "monitoring" : "doctor_confirming";
      const caseId = run(
        `INSERT INTO jaundice_cases(stay_id,code,level,status,prior_plan,created_by,created_by_name)
         VALUES(?,?,?,?,?,?,?)`,
        stayId, baseCode, triage.level, status, snapshotPriorPlan(stayId), user.id, user.name);
      const code = `${baseCode}-${caseId}`; // 追加事件id保证编号唯一、冒烟可重复运行
      run("UPDATE jaundice_cases SET code=? WHERE id=?", code, caseId);
      run(`INSERT INTO jaundice_measurements(case_id,stay_id,measured_at,method,value,trend,feeding,stool,urine,note,measured_by,measured_by_name)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        caseId, stayId, measuredAt, method, value, trend, feeding, str(p, "stool"), str(p, "urine"), str(p, "note"), user.id, user.name);
      const c = q1("SELECT * FROM jaundice_cases WHERE id=?", caseId)!;
      addEvent(c, "reported", user,
        `${method} ${value}mg/dL（趋势：${trend}）；喂养：${feeding}；大便：${str(p, "stool") || "-"}；小便：${str(p, "urine") || "-"}${str(p, "note") ? "；备注：" + str(p, "note") : ""}`);
      addEvent(c, "triaged", null, triage.reason + (triage.level === "enhanced"
        ? "。平台已启动加强复测；医生确认前家属端不展示处理建议，护理师不得自行承诺转诊或调整治疗。"
        : "。已提交儿科医生当班评估；医生确认前家属端仅提示观察中。"));
      run("UPDATE stays SET jaundice_level=?, jaundice_note=? WHERE id=?", value,
        `${method} ${value}mg/dL 升高处置中（${code}）`, stayId);
      // 内部护理记录：医生确认前不对家属可见
      run("INSERT INTO care_records(stay_id,type,content,created_by,created_by_name,visible_to_family) VALUES(?,?,?,?,?,0)",
        stayId, "jaundice", `黄疸升高上报：${method} ${value}mg/dL（${trend}），分级「${triage.level}」，闭环 ${code}。${triage.reason}`, user.id, user.name);
      // 联动异常工单中心（儿科/护士长）
      const severity = triage.level === "urgent" ? "critical" : triage.level === "doctor" ? "high" : "medium";
      createException(stayId, "jaundice",
        `宝宝黄疸${value}mg/dL（${triage.level === "urgent" ? "紧急转诊" : triage.level === "doctor" ? "医生当班评估" : "加强复测"}）`,
        `${measuredAt} ${method} ${value}mg/dL，趋势${trend}；${triage.reason}。详见黄疸处置闭环 ${code}。`, severity, user);
      // 加强复测档：平台自动排出复测待办（仍需医生确认建议后才对家属可见）
      const dutyNurse = q1("SELECT id,name FROM users WHERE id=? AND active=1", user.id) || { id: user.id, name: user.name };
      if (triage.level === "enhanced") {
        addTodo(c, "remeasure", "加强复测：6小时后复测黄疸并记录喂养/排泄", plusHours(measuredAt, 6), Number(dutyNurse.id), String(dutyNurse.name));
        addTodo(c, "remeasure", "加强复测：12小时后复测黄疸", plusHours(measuredAt, 12), Number(dutyNurse.id), String(dutyNurse.name));
      } else {
        addTodo(c, "review", "儿科医生当班评估并确认处理建议", plusHours(measuredAt, 1), null, "陈立（儿科医生）");
      }
      audit(stayId, user, "黄疸分级上报", `${code} ${method} ${value}mg/dL（${trend}）→ ${triage.level}`);
      return { id: caseId, code, level: triage.level, message: `已上报并分级为「${triage.level === "urgent" ? "紧急转诊" : triage.level === "doctor" ? "医生当班评估" : "加强复测"}」，处置闭环 ${code} 已建立` };
    },
  },

  // 加强复测：追加测量；级别升高自动回到医生确认，护士不得自行决定转诊
  "jaundice.remeasure": {
    roles: ["nurse", "matron", "head_nurse", "admin"],
    run(user, p) {
      const c = getCase(num(p, "id"));
      if (["resolved", "closed"].includes(String(c.status))) throw new Error("该闭环已结束，复测请新建上报");
      const method = str(p, "method", "TCB").toUpperCase();
      const value = num(p, "value", -1);
      if (value <= 0) throw new Error("请填写复测值");
      const prev = q1("SELECT value,method FROM jaundice_measurements WHERE case_id=? ORDER BY measured_at DESC,id DESC LIMIT 1", Number(c.id));
      let trend = str(p, "trend");
      if (!trend || trend === "auto") trend = prev ? (value > Number(prev.value) ? "上升" : value < Number(prev.value) ? "下降" : "持平") : "首次";
      const measuredAt = str(p, "measuredAt") ? toLocal(str(p, "measuredAt")) : now();
      run(`INSERT INTO jaundice_measurements(case_id,stay_id,measured_at,method,value,trend,feeding,stool,urine,note,measured_by,measured_by_name)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        Number(c.id), Number(c.stay_id), measuredAt, method, value, trend,
        req(p, "feeding", "喂养情况"), str(p, "stool"), str(p, "urine"), str(p, "note"), user.id, user.name);
      addEvent(c, "remeasured", user, `加强复测：${method} ${value}mg/dL（${trend}）；喂养：${req(p, "feeding", "喂养情况")}；大便：${str(p, "stool") || "-"}；小便：${str(p, "urine") || "-"}`);
      run("UPDATE stays SET jaundice_level=? WHERE id=?", value, Number(c.stay_id));
      // 关闭对应的复测待办
      if (num(p, "todoId")) {
        run("UPDATE jaundice_todos SET status='done', done_at=? WHERE id=? AND status='pending'", now(), num(p, "todoId"));
      } else {
        const t = q1("SELECT id FROM jaundice_todos WHERE case_id=? AND kind='remeasure' AND status='pending' ORDER BY due_at LIMIT 1", Number(c.id));
        if (t) run("UPDATE jaundice_todos SET status='done', done_at=? WHERE id=?", now(), Number(t.id));
      }
      // 重新分级：升高到更高级别时退回医生确认，护士不得自行转诊/调整治疗
      const newT = triageJaundice(method, value, trend.includes("升"));
      const rank: Record<string, number> = { enhanced: 1, doctor: 2, urgent: 3 };
      let msg = `复测已记录：${value}mg/dL（${trend}）`;
      if (rank[newT.level] > rank[String(c.level)]) {
        touchCase(Number(c.id), "level=?, status='doctor_confirming'", [newT.level]);
        addEvent(q1("SELECT * FROM jaundice_cases WHERE id=?", Number(c.id))!, "triaged", null,
          `复测后分级上调为「${newT.level === "urgent" ? "紧急转诊" : "医生当班评估"}」：${newT.reason}。等待儿科医生确认，护理师不得自行承诺转诊。`);
        addTodo(c, "review", "复测升高：儿科医生再次当班评估", plusHours(now(), 1), null, "儿科医生");
        msg += `，分级上调为「${newT.level === "urgent" ? "紧急转诊" : "医生当班评估"}」，已退回医生确认`;
      } else if (String(c.status) === "monitoring") {
        addTodo(c, "remeasure", "下一次加强复测（12小时后）", plusHours(now(), 12), user.id, user.name);
      }
      audit(Number(c.stay_id), user, "黄疸复测", `${c.code} ${method} ${value}mg/dL（${trend}）`);
      return { id: Number(c.id), level: newT.level, message: msg };
    },
  },

  // 医生当班评估：确认处理建议。确认前家属端不可见；护理师无权调用。
  "jaundice.doctorConfirm": {
    roles: ["pediatrician", "admin"],
    run(user, p) {
      const c = getCase(num(p, "id"));
      const advice = req(p, "advice", "经医生确认的处理建议");
      const decision = str(p, "decision", "monitor"); // monitor | referral
      let status = String(c.status);
      const extra: (string | number | null)[] = [];
      let patch = "doctor_advice=?, advice_visible_to_family=1, advice_by=?, advice_by_name=?, advice_confirmed_at=?";
      extra.push(advice, user.id, user.name, now());
      if (decision === "referral") {
        if (String(c.level) !== "urgent") {
          patch += ", level='urgent'";
        }
        patch += ", referral_reason=?, status='referral_pending_family'";
        extra.push(str(p, "referralReason", advice));
        status = "referral_pending_family";
        addTodo(c, "coordinate", "取得家属转诊确认", plusHours(now(), 1), null, "值班护理师");
      } else {
        patch += ", status='monitoring'";
        status = "monitoring";
        // 医生安排加强复测计划（时间可由医生指定，留空则自动 6h/12h/次日09:00）
        const times = parseTimes(str(p, "remeasureTimes"), [plusHours(now(), 6), plusHours(now(), 12), plusHours(now(), 24)]);
        const duty = q1(`SELECT u.id,u.name FROM care_plans cp JOIN users u ON u.id=cp.assignee_id
          WHERE cp.stay_id=? AND u.role='nurse' AND u.active=1 LIMIT 1`, Number(c.stay_id))
          || q1("SELECT id,name FROM users WHERE role='nurse' AND active=1 ORDER BY id LIMIT 1");
        for (const t of times) addTodo(c, "remeasure", `医生安排复测：${methodLabel(c)} ${t}`, t, duty ? Number(duty.id) : null, duty ? String(duty.name) : "");
      }
      touchCase(Number(c.id), patch, extra);
      const fresh = q1("SELECT * FROM jaundice_cases WHERE id=?", Number(c.id))!;
      addEvent(fresh, "doctor_confirmed", user,
        decision === "referral" || status === "referral_pending_family"
          ? `医生确认建议转诊：${advice}；转诊指征：${str(p, "referralReason", advice)}。建议已对家属可见，等待家属确认。`
          : `医生当班评估完成，确认处理建议（已对家属可见）：${advice}`);
      // 医生确认后形成家属可见护理记录
      run("INSERT INTO care_records(stay_id,type,content,created_by,created_by_name,visible_to_family) VALUES(?,?,?,?,?,1)",
        Number(c.stay_id), "jaundice", `儿科医生确认黄疸处理建议：${advice}`, user.id, user.name);
      const reviewTodo = q1("SELECT id FROM jaundice_todos WHERE case_id=? AND kind='review' AND status='pending' LIMIT 1", Number(c.id));
      if (reviewTodo) run("UPDATE jaundice_todos SET status='done', done_at=? WHERE id=?", now(), Number(reviewTodo.id));
      audit(Number(c.stay_id), user, "黄疸医生确认", `${c.code} → ${status === "referral_pending_family" ? "建议转诊，待家属确认" : "加强复测监测中"}`);
      return { id: Number(c.id), message: status === "referral_pending_family" ? "已确认转诊建议，等待家属确认" : "已确认处理建议并同步家属端，进入加强复测" };
    },
  },

  // 家属确认/暂拒转诊（护理师不能代操作）
  "jaundice.familyDecide": {
    roles: ["family"],
    run(user, p) {
      const c = getCase(num(p, "id"));
      const linked = q1("SELECT stay_id FROM family_links WHERE stay_id=? AND user_id=?", Number(c.stay_id), user.id);
      if (!linked) throw new Error("无权访问该房间");
      const decision = req(p, "decision", "决定"); // agree | decline
      if (!["agree", "decline"].includes(decision)) throw new Error("非法决定");
      if (!["referral_pending_family", "family_declined"].includes(String(c.status))) throw new Error("当前状态无需家属确认");
      if (decision === "agree") {
        touchCase(Number(c.id),
          "status='family_confirmed', family_decision='agree', family_decision_by=?, family_decision_name=?, family_decision_at=?",
          [user.id, user.name, now()]);
        addEvent(q1("SELECT * FROM jaundice_cases WHERE id=?", Number(c.id))!, "family_confirmed", user,
          `家属确认转诊：${str(p, "note") || "同意中心协调车辆并安排人员陪同"}。`);
        addTodo(c, "coordinate", "协调车辆/陪同人员/目标医院并备齐交接材料", plusHours(now(), 1), null, "值班护理师/护士长");
        audit(Number(c.stay_id), user, "家属确认转诊", `${c.code} 家属同意转诊`);
        return { message: "已确认转诊，中心将立即协调车辆与陪同人员" };
      }
      const risk = `家属拒绝转诊（${now().slice(0, 16)}）：${str(p, "note") || "未填写原因"}。已再次告知延误风险并自动升级护士长，继续中心留观。`;
      touchCase(Number(c.id),
        "status='family_declined', family_decision='decline', family_decision_by=?, family_decision_name=?, family_decision_at=?, escalated_head_nurse=1, escalate_reason=?, risk_note=?",
        [user.id, user.name, now(), "家属拒绝转诊导致转诊延迟", risk]);
      const fresh = q1("SELECT * FROM jaundice_cases WHERE id=?", Number(c.id))!;
      addEvent(fresh, "family_declined", user, `家属暂拒转诊：${str(p, "note") || "未填写原因"}`);
      addEvent(fresh, "escalated", null, "家属拒绝转诊，自动升级护士长介入沟通并保留风险说明。");
      addTodo(c, "coordinate", "【护士长】再次与家属沟通转诊风险并记录", plusHours(now(), 1), null, "护士长");
      audit(Number(c.stay_id), user, "家属拒绝转诊", `${c.code} 已自动升级护士长`);
      return { message: "已记录您的决定，护士长将与您再次沟通；期间中心会继续密切观察宝宝" };
    },
  },

  // 协调车辆/陪同/目标医院/交接；车辆或陪同拒绝 → 自动升级护士长并保留风险说明
  "jaundice.coordinate": {
    roles: ["nurse", "head_nurse", "admin"],
    run(user, p) {
      const c = getCase(num(p, "id"));
      if (!["family_confirmed", "coordinating", "upgraded"].includes(String(c.status))) {
        throw new Error("需家属确认转诊后才能协调");
      }
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      const vehicleResult = str(p, "vehicleResult"); // ok | declined
      const escortResult = str(p, "escortResult");
      if (str(p, "vehicle")) { sets.push("vehicle=?"); params.push(str(p, "vehicle")); }
      if (str(p, "escort")) { sets.push("escort=?"); params.push(str(p, "escort")); }
      if (str(p, "targetHospital")) { sets.push("target_hospital=?"); params.push(str(p, "targetHospital")); }
      if (str(p, "handoverContent")) {
        sets.push("handover_content=?, handover_by=?, handover_by_name=?");
        params.push(str(p, "handoverContent"), user.id, user.name);
      }
      let declined = false;
      if (vehicleResult === "declined") {
        sets.push("vehicle_status='车辆拒绝'");
        declined = true;
        addEvent(c, "vehicle_declined", user, `车辆协调失败：${str(p, "vehicle") || "合作转运车/120暂无车"}。原因：${str(p, "declineNote", "车辆拒绝派车")}`);
      } else if (vehicleResult === "ok") {
        sets.push("vehicle_status='已协调'");
        addEvent(c, "coordinated", user, `车辆已协调：${str(p, "vehicle") || "备用车辆"}。`);
      }
      if (escortResult === "declined") {
        sets.push("escort_status='陪同拒绝'");
        declined = true;
        addEvent(c, "escort_declined", user, `陪同人员无法到位：${str(p, "declineNote", "陪同拒绝")}`);
      } else if (escortResult === "ok") {
        sets.push("escort_status='已协调'");
        addEvent(c, "coordinated", user, `陪同人员已确定：${str(p, "escort") || ""}`);
      }
      if (str(p, "targetHospital")) addEvent(c, "coordinated", user, `目标医院：${str(p, "targetHospital")}。`);
      if (str(p, "handoverContent")) addEvent(c, "coordinated", user, "中心护理交接材料已备齐（黄疸记录、喂养排泄记录、证件/手册等）。");

      const fresh0 = q1("SELECT * FROM jaundice_cases WHERE id=?", Number(c.id))!;
      if (declined) {
        const reason = vehicleResult === "declined" ? "车辆拒绝派车导致转诊延迟" : "陪同人员无法到位导致转诊延迟";
        const risk = `【转诊延迟风险·${now().slice(0, 16)}】${reason}；${str(p, "declineNote", "未补充说明")}。已自动升级护士长协调备用资源，出发前持续监测宝宝情况。`;
        sets.push("status='upgraded', escalated_head_nurse=1, escalate_reason=?, risk_note=?");
        params.push(reason, risk);
        addEvent(fresh0, "escalated", null, `${reason}，系统自动升级护士长并保留风险说明。`);
        addTodo(c, "coordinate", "【护士长】立即协调备用车辆/陪同并记录", plusHours(now(), 1), null, "护士长");
        audit(Number(c.stay_id), user, "黄疸转诊升级", `${c.code} ${reason}`);
      }
      if (sets.length) touchCase(Number(c.id), sets.join(", "), params);
      const fresh = q1("SELECT * FROM jaundice_cases WHERE id=?", Number(c.id))!;
      // 资源齐备 → 协调完成（升级过的单据保留升级标记与风险说明，仅状态回到协调中）
      const ready = fresh.vehicle_status === "已协调" && fresh.escort_status === "已协调" && String(fresh.target_hospital || "");
      if (!declined && ready && String(fresh.status) !== "referred") {
        if (String(fresh.status) !== "coordinating") {
          run("UPDATE jaundice_cases SET status='coordinating', updated_at=? WHERE id=?", now(), Number(c.id));
          addEvent(fresh, "coordinated", user, "车辆、陪同人员、目标医院与交接材料齐备，等待出发。");
        }
        const todo = q1("SELECT id FROM jaundice_todos WHERE case_id=? AND kind='coordinate' AND status='pending' AND title LIKE '%车辆%' LIMIT 1", Number(c.id));
        if (todo) run("UPDATE jaundice_todos SET status='done', done_at=? WHERE id=?", now(), Number(todo.id));
      }
      audit(Number(c.stay_id), user, "黄疸转诊协调", `${c.code} 车辆=${fresh.vehicle_status || "-"} 陪同=${fresh.escort_status || "-"} 医院=${fresh.target_hospital || "-"}`);
      return {
        id: Number(c.id),
        message: declined
          ? "已记录资源拒绝并自动升级护士长，风险说明已留存"
          : ready ? "转诊资源已齐备，可以出发" : "协调信息已保存",
      };
    },
  },

  // 出发 / 到达外院
  "jaundice.transport": {
    roles: ["nurse", "head_nurse", "admin"],
    run(user, p) {
      const c = getCase(num(p, "id"));
      const stage = req(p, "stage", "转运阶段");
      if (stage === "depart") {
        if (!["family_confirmed", "coordinating", "upgraded"].includes(String(c.status))) throw new Error("当前状态不能出发");
        const missing = [
          c.vehicle_status !== "已协调" ? "车辆" : "",
          c.escort_status !== "已协调" ? "陪同人员" : "",
          !c.target_hospital ? "目标医院" : "",
          !c.handover_content ? "交接材料" : "",
        ].filter(Boolean);
        if (missing.length) throw new Error(`出发前仍缺：${missing.join("、")}`);
        run("UPDATE jaundice_cases SET status='referred', departed_at=COALESCE(departed_at,?), updated_at=? WHERE id=?",
          str(p, "at") ? toLocal(str(p, "at")) : now(), now(), Number(c.id));
        addEvent(q1("SELECT * FROM jaundice_cases WHERE id=?", Number(c.id))!, "departed", user,
          `宝宝出发转诊：${c.vehicle}；陪同 ${c.escort}；目标医院 ${c.target_hospital}。`);
        for (const t of q("SELECT id FROM jaundice_todos WHERE case_id=? AND kind='coordinate' AND status='pending'", Number(c.id))) {
          run("UPDATE jaundice_todos SET status='done', done_at=? WHERE id=?", now(), Number(t.id));
        }
        addTodo(c, "follow_hospital", "到达外院后回传接收与交接情况", plusHours(now(), 2), user.id, user.name);
        audit(Number(c.stay_id), user, "黄疸转诊出发", `${c.code} → ${c.target_hospital}`);
        return { message: "已登记出发，宝宝转诊外院中" };
      }
      if (stage === "arrive") {
        if (String(c.status) !== "referred") throw new Error("尚未出发或已登记到达");
        run("UPDATE jaundice_cases SET arrived_at=COALESCE(arrived_at,?), updated_at=? WHERE id=?",
          str(p, "at") ? toLocal(str(p, "at")) : now(), now(), Number(c.id));
        addEvent(q1("SELECT * FROM jaundice_cases WHERE id=?", Number(c.id))!, "arrived", user,
          `到达${c.target_hospital}并完成中心护理交接：${str(p, "note", "新生儿科接收，交接材料已签字")}。`);
        const t = q1("SELECT id FROM jaundice_todos WHERE case_id=? AND kind='follow_hospital' AND status='pending' LIMIT 1", Number(c.id));
        if (t) run("UPDATE jaundice_todos SET status='done', done_at=? WHERE id=?", now(), Number(t.id));
        audit(Number(c.stay_id), user, "黄疸转诊到达", `${c.code} 到达 ${c.target_hospital}`);
        return { message: "已登记到达与外院交接" };
      }
      throw new Error("未知转运阶段");
    },
  },

  // 宝宝返回中心：登记外院回执；与原中心计划冲突时挂起常规护理，必须医生复核
  "jaundice.return": {
    roles: ["nurse", "head_nurse", "admin"],
    run(user, p) {
      const c = getCase(num(p, "id"));
      if (String(c.status) !== "referred" || !c.arrived_at) throw new Error("宝宝尚未转诊到达外院，不能登记返中心");
      const receipt = req(p, "hospitalReceipt", "外院回执（诊断/处理/带药/复诊）");
      const stay = q1("SELECT feeding_method FROM stays WHERE id=?", Number(c.stay_id))!;
      // 系统自动识别冲突关键词（表单可人工复核勾选）
      let conflict = bool(p, "conflict");
      let detail = str(p, "conflictDetail");
      if (!conflict && /暂停母乳|停母乳|停止母乳|配方奶喂养/.test(receipt) && String(stay.feeding_method || "").includes("母乳")) {
        conflict = true;
        detail = detail || "外院建议暂停/停止母乳喂养，与本中心原母乳喂养观察计划冲突";
      }
      const overdue = cancelTodos(Number(c.id), "宝宝转诊外院，旧复测提醒过期，返中心后依回执重建", true);
      run(`UPDATE jaundice_cases
           SET returned_at=?, hospital_receipt=?, conflict=?, conflict_detail=?,
               status=?, updated_at=? WHERE id=?`,
        str(p, "returnedAt") ? toLocal(str(p, "returnedAt")) : now(),
        receipt, conflict ? 1 : 0, detail, conflict ? "conflict_review" : "returned", now(), Number(c.id));
      const fresh = q1("SELECT * FROM jaundice_cases WHERE id=?", Number(c.id))!;
      addEvent(fresh, "returned", user, `宝宝光疗/诊治后返回中心，提交外院回执：${receipt}；转诊期间${overdue}项过期复测提醒已取消。`);
      if (conflict) {
        addEvent(fresh, "conflict_flagged", null, `外院建议与原中心计划冲突（${detail || "详见回执"}），在医生复核通过前暂停恢复常规护理，护理师不得自行调整治疗。`);
        addTodo(fresh, "review", "外院建议冲突：必须由儿科医生复核后才能恢复常规护理", plusHours(now(), 2), null, "儿科医生");
      } else {
        addTodo(fresh, "review", "凭外院回执由医生确认新建议并重建观察计划", plusHours(now(), 2), null, "儿科医生");
      }
      audit(Number(c.stay_id), user, "黄疸返中心", `${c.code} 回执已登记${conflict ? "，冲突待医生复核" : ""}，取消过期提醒${overdue}项`);
      return { id: Number(c.id), conflict, message: conflict ? "外院建议与原计划冲突，已挂起常规护理，等待医生复核" : "回执已登记，等待医生确认新建议并重建观察计划" };
    },
  },

  // 医生复核回执/冲突 → 重建观察计划、取消过期提醒、同步护理师排班 → 恢复常规护理
  "jaundice.doctorReview": {
    roles: ["pediatrician", "admin"],
    run(user, p) {
      const c = getCase(num(p, "id"));
      if (!["returned", "conflict_review"].includes(String(c.status))) throw new Error("当前状态无需医生复核");
      const reviewNote = req(p, "reviewNote", "医生复核意见");
      const frequency = req(p, "frequency", "新观察计划频次");
      const assigneeId = num(p, "assigneeId");
      const nurse = assigneeId
        ? q1("SELECT id,name FROM users WHERE id=? AND role IN ('nurse','matron','head_nurse')", assigneeId)
        : q1("SELECT id,name FROM users WHERE role='nurse' AND active=1 ORDER BY id LIMIT 1");
      if (!nurse) throw new Error("请指定负责护理师以同步排班");

      // 1) 旧黄疸观察计划作废，其未完成任务作为过期提醒取消
      const oldPlans = q("SELECT id,title FROM care_plans WHERE stay_id=? AND type='jaundice_obs' AND status='active'", Number(c.stay_id));
      let cancelledTasks = 0;
      for (const pl of oldPlans) {
        const ts = q("SELECT id FROM care_tasks WHERE plan_id=? AND status='pending'", Number(pl.id));
        for (const t of ts) {
          run("UPDATE care_tasks SET status='missed', record=? WHERE id=?",
            `外院返中心后医生复核重建计划，旧任务过期取消（${c.code}）`, Number(t.id));
          cancelledTasks++;
        }
        run("UPDATE care_plans SET status='cancelled', note=? WHERE id=?",
          `医生复核重建（${c.code}）：${reviewNote.slice(0, 80)}`, Number(pl.id));
      }
      const cancelledTodos = cancelTodos(Number(c.id), "医生复核完成，按新观察计划重建待办");

      // 2) 依外院回执 + 医生新建议重建观察计划
      const planId = run("INSERT INTO care_plans(stay_id,type,title,frequency,assignee_id,status,note) VALUES(?,?,?,?,?,'active',?)",
        Number(c.stay_id), "jaundice_obs", "黄疸观察复测（外院返中心·医生复核版）", frequency,
        Number(nurse.id), `依据外院回执与医生复核意见重建：${reviewNote.slice(0, 120)}`);
      const times = parseTimes(str(p, "remeasureTimes"), [plusHours(now(), 4), plusHours(now(), 12), plusHours(now(), 24)]);
      let madeTasks = 0;
      for (const t of times) {
        run("INSERT INTO care_tasks(stay_id,plan_id,type,title,scheduled_at,assignee_id,status,visible_to_family) VALUES(?,?,?,?,?,?,'pending',1)",
          Number(c.stay_id), planId, "jaundice_obs", "黄疸复测（复核重建计划）", t, Number(nurse.id));
        madeTasks++;
      }

      // 3) 复核留痕、恢复常规护理
      run(`UPDATE jaundice_cases
           SET review_note=?, reviewed_by=?, reviewed_by_name=?, reviewed_at=?,
               status='resolved', routine_resumed_at=?, advice_visible_to_family=1,
               doctor_advice=?, closed_at=NULL, updated_at=? WHERE id=?`,
        reviewNote, user.id, user.name, now(), now(),
        `【返中心后医生新建议】${reviewNote}`, now(), Number(c.id));
      const fresh = q1("SELECT * FROM jaundice_cases WHERE id=?", Number(c.id))!;
      addEvent(fresh, "reviewed", user, `医生复核${Number(c.conflict) ? "（存在外院建议冲突，已复核通过）" : ""}：${reviewNote}`);
      addEvent(fresh, "plan_rebuilt", user,
        `依外院回执与医生新建议重建观察计划（${frequency}，负责护理师 ${nurse.name}）：新增复测任务${madeTasks}项、同步护理师排班；作废旧计划${oldPlans.length}个、取消过期任务${cancelledTasks}项、取消过期待办${cancelledTodos}项。`);
      addEvent(fresh, "routine_resumed", user, "复核通过且新观察计划已下发护理师排班，恢复常规护理。");
      run("INSERT INTO care_records(stay_id,type,content,created_by,created_by_name,visible_to_family) VALUES(?,?,?,?,?,1)",
        Number(c.stay_id), "jaundice",
        `黄疸转诊返中心闭环：医生复核完成，重建观察计划（${frequency}）并同步${nurse.name}排班。${reviewNote}`,
        user.id, user.name);
      run("INSERT INTO messages(stay_id,from_user_id,from_name,from_role,audience,content) VALUES(?,?,?,?,?,?)",
        Number(c.stay_id), user.id, user.name, user.role, "all",
        `宝宝已从外院返回，医生已完成复核并安排新的黄疸观察计划（${frequency}）。${reviewNote}`);
      linkException(Number(c.stay_id), String(c.code));
      audit(Number(c.stay_id), user, "黄疸复核重建",
        `${c.code} 新计划「${frequency}」同步${nurse.name}；旧任务取消${cancelledTasks}，过期待办取消${cancelledTodos}，恢复常规护理`);
      return { id: Number(c.id), message: `复核完成：新观察计划已重建并同步护理师排班（复测${madeTasks}项），已恢复常规护理` };
    },
  },

  // 护理主管核对全程时间线/交接材料/未完成事项后关闭闭环
  "jaundice.close": {
    roles: ["head_nurse", "admin"],
    run(user, p) {
      const c = getCase(num(p, "id"));
      if (String(c.status) !== "resolved") throw new Error("仅已完成（复核重建并恢复常规护理）的闭环可关闭");
      const pending = q("SELECT COUNT(*) AS c FROM jaundice_todos WHERE case_id=? AND status='pending'", Number(c.id));
      if (Number(pending[0].c) > 0) throw new Error(`仍有 ${Number(pending[0].c)} 项未完成事项，全部办结后才能关闭闭环`);
      run("UPDATE jaundice_cases SET status='closed', closed_at=?, updated_at=? WHERE id=?", now(), now(), Number(c.id));
      addEvent(q1("SELECT * FROM jaundice_cases WHERE id=?", Number(c.id))!, "closed", user,
        `护理主管核对全程时间线、转诊交接材料与未完成事项（均已办结）后关闭闭环。${str(p, "note") ? "备注：" + str(p, "note") : ""}`);
      audit(Number(c.stay_id), user, "黄疸闭环关闭", `${c.code} 全程材料核对无误`);
      return { message: "闭环已关闭" };
    },
  },

  // 追加过程备注（员工）
  "jaundice.note": {
    roles: ["nurse", "matron", "head_nurse", "admin", "pediatrician"],
    run(user, p) {
      const c = getCase(num(p, "id"));
      addEvent(c, "note", user, req(p, "note", "备注内容"));
      run("UPDATE jaundice_cases SET updated_at=? WHERE id=?", now(), Number(c.id));
      return { message: "已追加备注" };
    },
  },
};

function methodLabel(c: Row): string {
  const m = q1("SELECT method FROM jaundice_measurements WHERE case_id=? ORDER BY measured_at DESC,id DESC LIMIT 1", Number(c.id));
  return m ? String(m.method) : "TCB";
}

// ---------------------------------------------------------------- 页面查询
export function getJaundiceCaseDetail(caseId: number): {
  data?: Row; stay?: Row; measurements: Row[]; events: Row[]; todos: Row[];
} {
  const data = q1(
    `SELECT jc.*, r.number AS room_number, s.mother_name, s.baby_name, s.feeding_method
     FROM jaundice_cases jc
     JOIN stays s ON s.id=jc.stay_id JOIN rooms r ON r.id=s.room_id
     WHERE jc.id=?`, caseId);
  if (!data) return { measurements: [], events: [], todos: [] };
  const stay = q1("SELECT * FROM stays WHERE id=?", Number(data.stay_id));
  const measurements = q("SELECT * FROM jaundice_measurements WHERE case_id=? ORDER BY measured_at DESC, id DESC", caseId);
  const events = q("SELECT * FROM jaundice_events WHERE case_id=? ORDER BY created_at DESC, id DESC", caseId);
  const todos = q("SELECT * FROM jaundice_todos WHERE case_id=? ORDER BY status='pending' DESC, due_at, id", caseId);
  return { data, stay, measurements, events, todos };
}

export function listJaundiceCases(opts: { stayId?: number; openOnly?: boolean } = {}): Row[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.stayId) { where.push("jc.stay_id=?"); params.push(opts.stayId); }
  if (opts.openOnly) { where.push("jc.status NOT IN ('resolved','closed')"); }
  const sql = `SELECT jc.*, r.number AS room_number, s.mother_name, s.baby_name,
      (SELECT value FROM jaundice_measurements m WHERE m.case_id=jc.id ORDER BY m.measured_at DESC, m.id DESC LIMIT 1) AS last_value,
      (SELECT method FROM jaundice_measurements m WHERE m.case_id=jc.id ORDER BY m.measured_at DESC, m.id DESC LIMIT 1) AS last_method,
      (SELECT COUNT(*) FROM jaundice_todos t WHERE t.case_id=jc.id AND t.status='pending') AS pending_todos
    FROM jaundice_cases jc
    JOIN stays s ON s.id=jc.stay_id JOIN rooms r ON r.id=s.room_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY jc.status NOT IN ('resolved','closed') DESC, jc.updated_at DESC`;
  return q(sql, ...params);
}

// 家属可见的黄疸处置：仅展示医生已确认的建议
export function listFamilyJaundice(stayId: number): Row[] {
  return q(
    `SELECT * FROM jaundice_cases
     WHERE stay_id=? AND advice_visible_to_family=1
     ORDER BY updated_at DESC`, stayId);
}

export function jaundiceOpenStats() {
  const row = q1(
    `SELECT
       SUM(CASE WHEN status IN ('reported','doctor_confirming') THEN 1 ELSE 0 END) AS awaiting_doctor,
       SUM(CASE WHEN status IN ('referral_pending_family','family_confirmed','coordinating','referred','returned','conflict_review') THEN 1 ELSE 0 END) AS referral_flow,
       SUM(CASE WHEN status='upgraded' THEN 1 ELSE 0 END) AS upgraded,
       SUM(CASE WHEN status='family_declined' THEN 1 ELSE 0 END) AS family_declined
     FROM jaundice_cases WHERE status NOT IN ('resolved','closed')`);
  return row || {};
}
