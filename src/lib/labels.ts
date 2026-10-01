// 展示用字典与通用工具
export const ROLE_LABELS: Record<string, string> = {
  admin: "中心管理者",
  head_nurse: "护士长",
  nurse: "护理师",
  pediatrician: "儿科医生",
  nutritionist: "营养师",
  therapist: "产康师",
  matron: "月嫂",
  frontdesk: "前台",
  finance: "财务",
  family: "家属",
};

export const ROLE_HOME: Record<string, string> = {
  admin: "/admin",
  head_nurse: "/headnurse",
  nurse: "/nurse",
  pediatrician: "/doctor",
  nutritionist: "/nutritionist",
  therapist: "/therapist",
  matron: "/nurse",
  frontdesk: "/frontdesk",
  finance: "/finance",
  family: "/family",
};

export const PLAN_TYPES: Record<string, string> = {
  rounds: "护理查房",
  wound: "伤口观察",
  breast: "乳房护理",
  recovery: "产康课程",
  meal: "月子餐",
  baby_bath: "宝宝洗澡抚触",
  night_care: "夜间照护",
  jaundice_obs: "黄疸观察复测",
};

// ===== 宝宝黄疸分级处置与转诊闭环 =====
export const JAUNDICE_LEVELS: Record<string, string> = {
  enhanced: "加强复测",
  doctor: "医生当班评估",
  urgent: "紧急转诊",
};

export const JAUNDICE_STATUSES: Record<string, string> = {
  reported: "已上报待分级",
  doctor_confirming: "待医生当班评估确认",
  monitoring: "加强复测监测中",
  referral_pending_family: "待家属确认转诊",
  family_confirmed: "家属已确认·待协调",
  family_declined: "家属暂拒转诊·观察留观",
  coordinating: "转诊协调中",
  upgraded: "转诊延迟·已升级护士长",
  referred: "转诊外院中",
  returned: "已返中心·待处理回执",
  conflict_review: "外院建议冲突·待医生复核",
  resolved: "闭环已完成",
  closed: "已关闭",
};

export const JAUNDICE_METHODS: Record<string, string> = {
  TCB: "经皮胆红素(TCB)",
  TSB: "血清胆红素(TSB)",
};

export const JAUNDICE_TODO_KINDS: Record<string, string> = {
  remeasure: "黄疸复测",
  coordinate: "转诊协调",
  review: "医生复核",
  follow_hospital: "外院跟进",
};

export const JAUNDICE_EVENTS: Record<string, string> = {
  reported: "测量上报",
  triaged: "阈值分级",
  remeasured: "加强复测",
  escalated: "升级护士长",
  doctor_confirmed: "医生确认建议",
  family_confirmed: "家属确认转诊",
  family_declined: "家属拒绝转诊",
  coordinated: "转诊协调",
  vehicle_declined: "车辆拒绝",
  escort_declined: "陪同人员无法到位",
  departed: "出发转诊",
  arrived: "到达外院交接",
  returned: "宝宝返回中心",
  conflict_flagged: "建议冲突待复核",
  reviewed: "医生复核",
  plan_rebuilt: "重建观察计划",
  routine_resumed: "恢复常规护理",
  closed: "闭环关闭",
  note: "备注",
};

export function jaundiceLevelClass(level: string): string {
  if (level === "urgent") return "badge red";
  if (level === "doctor") return "badge amber";
  return "badge blue";
}

export function jaundiceStatusClass(status: string): string {
  switch (status) {
    case "resolved": case "closed": return "badge green";
    case "referred": return "badge blue";
    case "upgraded": case "referral_pending_family": case "family_declined":
    case "conflict_review": case "reported": return "badge red";
    default: return "badge amber";
  }
}

export const EX_TYPES: Record<string, string> = {
  jaundice: "宝宝黄疸升高",
  breast_blockage: "产妇乳腺堵塞",
  extra_visit: "家属临时增加探访",
  matron_leave: "月嫂请假",
  meal_taboo: "餐食不符合忌口",
  project_delay: "产康项目延期",
  package_upgrade: "套餐升级",
  room_upgrade: "房间升级",
  early_checkout: "提前退所",
  record_dispute: "家属质疑护理记录",
  checkout_dispute: "退所争议",
};

export const FEE_TYPES: Record<string, string> = {
  package: "套餐费用",
  upgrade: "升级差价",
  extra: "增项消费",
  deposit: "押金",
  discount: "减免",
  refund: "退款",
};

export const EX_STATUS: Record<string, string> = {
  open: "待处理",
  processing: "处理中",
  resolved: "已解决",
  closed: "已关闭",
};

export const SEVERITY: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "紧急",
};

export const TASK_STATUS: Record<string, string> = {
  pending: "待执行",
  done: "已完成",
  delayed: "已延期",
  missed: "已遗漏",
};

export const VISIT_STATUS: Record<string, string> = {
  pending: "待审核",
  approved: "已批准",
  rejected: "已拒绝",
  completed: "已完成",
  cancelled: "已取消",
};

export function money(n: unknown): string {
  const v = Number(n || 0);
  return "¥" + v.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function dt(s: unknown): string {
  if (!s) return "-";
  return String(s).slice(0, 16);
}

export function badgeClass(status: string): string {
  switch (status) {
    case "open": case "pending": case "issue": case "new": return "badge red";
    case "processing": case "planned": case "scheduled": case "following": case "draft": return "badge amber";
    case "resolved": case "done": case "confirmed": case "approved": case "delivered": case "responded": case "converted": return "badge green";
    case "closed": case "cancelled": case "void": case "rejected": case "lost": return "badge gray";
    case "completed": case "active": case "in_stay": return "badge blue";
    case "checked_out": return "badge gray";
    default: return "badge gray";
  }
}

export function severityClass(sev: string): string {
  switch (sev) {
    case "critical": return "badge red";
    case "high": return "badge red";
    case "medium": return "badge amber";
    default: return "badge gray";
  }
}
