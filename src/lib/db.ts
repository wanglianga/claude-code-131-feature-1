// 数据库层：node:sqlite 单例 + schema + 种子数据
// SQL 均为标准语法，可平滑迁移到 MySQL（见 README）。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = process.env.MCARE_DB || path.join(DATA_DIR, "mcare.db");

export function hashPassword(password: string, salt: string): string {
  return crypto.createHash("sha256").update(salt + ":" + password).digest("hex");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  phone TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS rooms(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  floor TEXT DEFAULT '',
  status TEXT DEFAULT 'vacant'
);
CREATE TABLE IF NOT EXISTS packages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  days INTEGER NOT NULL,
  price REAL NOT NULL,
  room_type TEXT NOT NULL,
  includes TEXT DEFAULT '',
  gifts TEXT DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS stays(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  package_id INTEGER NOT NULL REFERENCES packages(id),
  mother_name TEXT NOT NULL,
  mother_phone TEXT DEFAULT '',
  delivery_method TEXT DEFAULT '',
  postpartum_days INTEGER DEFAULT 0,
  allergy_history TEXT DEFAULT '',
  feeding_method TEXT DEFAULT '',
  meal_taboos TEXT DEFAULT '',
  doctor_advice TEXT DEFAULT '',
  visit_permissions TEXT DEFAULT '{}',
  baby_name TEXT DEFAULT '',
  baby_weight REAL DEFAULT 0,
  jaundice_level REAL DEFAULT 0,
  jaundice_note TEXT DEFAULT '',
  status TEXT DEFAULT 'in_stay',
  check_in_date TEXT NOT NULL,
  expected_checkout TEXT NOT NULL,
  actual_checkout TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS family_links(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  relation TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS care_plans(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  frequency TEXT DEFAULT '',
  assignee_id INTEGER REFERENCES users(id),
  status TEXT DEFAULT 'active',
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS care_tasks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  plan_id INTEGER REFERENCES care_plans(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  assignee_id INTEGER REFERENCES users(id),
  status TEXT DEFAULT 'pending',
  done_at TEXT,
  done_by INTEGER,
  record TEXT DEFAULT '',
  visible_to_family INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS care_records(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  task_id INTEGER REFERENCES care_tasks(id),
  type TEXT DEFAULT '',
  content TEXT NOT NULL,
  created_by INTEGER,
  created_by_name TEXT DEFAULT '',
  visible_to_family INTEGER DEFAULT 1,
  disputed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS meals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  meal_date TEXT NOT NULL,
  meal_type TEXT NOT NULL,
  menu TEXT NOT NULL,
  taboo_hits TEXT DEFAULT '',
  status TEXT DEFAULT 'planned',
  note TEXT DEFAULT '',
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS visits(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  visitor_name TEXT NOT NULL,
  relation TEXT DEFAULT '',
  visit_time TEXT NOT NULL,
  hours INTEGER DEFAULT 2,
  is_temp INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  disinfected INTEGER DEFAULT 0,
  disinfection_note TEXT DEFAULT '',
  approved_by INTEGER,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS fees(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  type TEXT NOT NULL,
  direction TEXT DEFAULT 'charge',
  amount REAL NOT NULL,
  description TEXT DEFAULT '',
  status TEXT DEFAULT 'confirmed',
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS gifts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  name TEXT NOT NULL,
  source TEXT DEFAULT 'package',
  status TEXT DEFAULT 'pending',
  delivered_at TEXT,
  delivered_by INTEGER
);
CREATE TABLE IF NOT EXISTS therapist_schedules(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  therapist_id INTEGER REFERENCES users(id),
  project TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  status TEXT DEFAULT 'scheduled',
  delay_reason TEXT DEFAULT '',
  done_at TEXT
);
CREATE TABLE IF NOT EXISTS hosting_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  baby_name TEXT DEFAULT '',
  type TEXT DEFAULT '托管',
  start_time TEXT NOT NULL,
  end_time TEXT,
  caregiver_id INTEGER,
  caregiver_name TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS doctor_rounds(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  doctor_id INTEGER,
  doctor_name TEXT DEFAULT '',
  round_date TEXT NOT NULL,
  findings TEXT DEFAULT '',
  advice TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS exceptions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  severity TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'open',
  raised_by INTEGER,
  raised_by_name TEXT DEFAULT '',
  assigned_role TEXT DEFAULT '',
  resolution TEXT DEFAULT '',
  synced_head_nurse INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS exception_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exception_id INTEGER NOT NULL REFERENCES exceptions(id),
  user_id INTEGER,
  user_name TEXT DEFAULT '',
  action TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS feedbacks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  user_id INTEGER,
  user_name TEXT DEFAULT '',
  rating INTEGER DEFAULT 5,
  content TEXT DEFAULT '',
  status TEXT DEFAULT 'new',
  response TEXT DEFAULT '',
  affect_scheduling INTEGER DEFAULT 0,
  handled_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS follow_ups(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  type TEXT DEFAULT '回访',
  scheduled_at TEXT NOT NULL,
  content TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  result TEXT DEFAULT '',
  created_by INTEGER,
  done_at TEXT
);
CREATE TABLE IF NOT EXISTS referrals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  kind TEXT DEFAULT 'referral',
  lead_name TEXT NOT NULL,
  lead_phone TEXT DEFAULT '',
  note TEXT DEFAULT '',
  status TEXT DEFAULT 'new',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS settlements(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER UNIQUE NOT NULL REFERENCES stays(id),
  total_charge REAL DEFAULT 0,
  total_refund REAL DEFAULT 0,
  paid REAL DEFAULT 0,
  balance REAL DEFAULT 0,
  detail TEXT DEFAULT '',
  status TEXT DEFAULT 'draft',
  confirmed_by INTEGER,
  confirmed_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  from_user_id INTEGER,
  from_name TEXT DEFAULT '',
  from_role TEXT DEFAULT '',
  audience TEXT DEFAULT 'staff',
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS audit_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER REFERENCES stays(id),
  actor_id INTEGER,
  actor_name TEXT DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ===== 宝宝黄疸分级处置与转诊闭环 =====
-- 一次黄疸升高处置事件（监测→医生确认→（转诊协调→转诊中→返中心复核）→恢复常规/关闭）
CREATE TABLE IF NOT EXISTS jaundice_cases(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  code TEXT DEFAULT '',
  level TEXT NOT NULL DEFAULT 'enhanced',          -- enhanced=加强复测 / doctor=医生当班评估 / urgent=紧急转诊
  status TEXT NOT NULL DEFAULT 'reported',         -- reported/doctor_confirming/monitoring/referral_pending_family/family_confirmed/family_declined/coordinating/referred/returned/conflict_review/resolved/closed/upgraded
  risk_note TEXT DEFAULT '',                        -- 风险说明（延迟升级等必须留痕）
  escalated_head_nurse INTEGER DEFAULT 0,           -- 是否已升级护士长
  escalate_reason TEXT DEFAULT '',
  escalated_at TEXT,
  prior_plan TEXT DEFAULT '',                       -- 既往观察计划快照
  doctor_advice TEXT DEFAULT '',                    -- 医生确认的处理建议（唯一可向家属展示的口径）
  advice_visible_to_family INTEGER DEFAULT 0,       -- 医生确认前为0：护理师不得自行承诺
  advice_by INTEGER,
  advice_by_name TEXT DEFAULT '',
  advice_confirmed_at TEXT,
  referral_reason TEXT DEFAULT '',                  -- 转诊指征/医生转诊说明
  family_decision TEXT DEFAULT '',                  -- agree / decline
  family_decision_by INTEGER,
  family_decision_name TEXT DEFAULT '',
  family_decision_at TEXT,
  vehicle TEXT DEFAULT '',
  vehicle_status TEXT DEFAULT '',                   -- 已协调 / 车辆拒绝
  escort TEXT DEFAULT '',
  escort_status TEXT DEFAULT '',                    -- 已协调 / 陪同拒绝
  target_hospital TEXT DEFAULT '',
  handover_content TEXT DEFAULT '',                 -- 中心护理交接材料
  handover_by INTEGER,
  handover_by_name TEXT DEFAULT '',
  departed_at TEXT,                                 -- 实际出发（中心→外院）
  arrived_at TEXT,                                  -- 到达外院
  hospital_receipt TEXT DEFAULT '',                 -- 外院回执（诊断/处理/带药/复诊）
  returned_at TEXT,                                 -- 宝宝返回中心时间
  conflict INTEGER DEFAULT 0,                       -- 外院建议与原中心计划冲突=1，须医生复核
  conflict_detail TEXT DEFAULT '',
  review_note TEXT DEFAULT '',                      -- 医生复核意见
  reviewed_by INTEGER,
  reviewed_by_name TEXT DEFAULT '',
  reviewed_at TEXT,
  routine_resumed_at TEXT,                          -- 复核通过恢复常规护理时间
  created_by INTEGER,
  created_by_name TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS jaundice_measurements(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES jaundice_cases(id),
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  measured_at TEXT NOT NULL,                        -- 测量时间
  method TEXT NOT NULL DEFAULT 'TCB',               -- TCB 经皮 / TSB 血清
  value REAL NOT NULL,                              -- mg/dL
  trend TEXT DEFAULT '',                            -- 上升/持平/下降（与上一次比较）
  feeding TEXT DEFAULT '',                          -- 喂养情况
  stool TEXT DEFAULT '',                            -- 排泄情况（大便）
  urine TEXT DEFAULT '',                            -- 排泄情况（小便）
  note TEXT DEFAULT '',
  measured_by INTEGER,
  measured_by_name TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS jaundice_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES jaundice_cases(id),
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  event_type TEXT NOT NULL,
  actor_id INTEGER,
  actor_name TEXT DEFAULT '',
  actor_role TEXT DEFAULT '',
  detail TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
-- 待办（复测提醒 / 协调事项 / 复核事项）；重建计划时批量取消过期待办
CREATE TABLE IF NOT EXISTS jaundice_todos(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES jaundice_cases(id),
  stay_id INTEGER NOT NULL REFERENCES stays(id),
  kind TEXT NOT NULL DEFAULT 'remeasure',           -- remeasure/coordinate/review/follow_hospital
  title TEXT NOT NULL,
  due_at TEXT,
  assignee_id INTEGER,
  assignee_name TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',           -- pending/done/cancelled
  cancel_reason TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  done_at TEXT
);
`;

type Row = Record<string, unknown>;

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  // 复用全局实例，避免 Next.js 开发模式热更新导致多开
  const g = globalThis as unknown as { __mcareDb?: DatabaseSync };
  if (g.__mcareDb) return g.__mcareDb;
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(SCHEMA);
  const cnt = db.prepare("SELECT COUNT(*) AS c FROM users").get() as Row;
  if (Number(cnt.c) === 0) {
    seed(db);
  }
  g.__mcareDb = db;
  _db = db;
  return db;
}

export function q(sql: string, ...params: (string | number | null)[]): Row[] {
  return getDb().prepare(sql).all(...params) as Row[];
}
export function q1(sql: string, ...params: (string | number | null)[]): Row | undefined {
  return getDb().prepare(sql).get(...params) as Row | undefined;
}
export function run(sql: string, ...params: (string | number | null)[]): number {
  const r = getDb().prepare(sql).run(...params);
  return Number(r.lastInsertRowid);
}
export function now(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
export function today(): string {
  return now().slice(0, 10);
}
export function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00");
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function seed(db: DatabaseSync) {
  const ins = (sql: string, ...params: (string | number | null)[]) =>
    db.prepare(sql).run(...params);

  // ---- 用户 ----
  const addUser = (username: string, password: string, name: string, role: string, phone = "") => {
    const salt = crypto.randomBytes(8).toString("hex");
    const r = ins(
      "INSERT INTO users(username,password_hash,salt,name,role,phone) VALUES(?,?,?,?,?,?)",
      username, hashPassword(password, salt), salt, name, role, phone
    );
    return Number(r.lastInsertRowid);
  };
  const admin = addUser("admin", "admin123", "沈总", "admin", "13800000001");
  const headNurse = addUser("headnurse", "head123", "周敏（护士长）", "head_nurse", "13800000002");
  const nurse1 = addUser("nurse1", "nurse123", "王芳（护理师）", "nurse", "13800000003");
  const nurse2 = addUser("nurse2", "nurse123", "李婷（护理师）", "nurse", "13800000004");
  const doctor = addUser("doctor", "doc123", "陈立（儿科医生）", "pediatrician", "13800000005");
  const nutrition = addUser("nutrition", "nut123", "赵芸（营养师）", "nutritionist", "13800000006");
  const therapist = addUser("therapist", "the123", "孙倩（产康师）", "therapist", "13800000007");
  const matron = addUser("matron", "mat123", "王嫂（月嫂）", "matron", "13800000008");
  const front = addUser("front", "front123", "小钱（前台）", "frontdesk", "13800000009");
  const finance = addUser("finance", "fin123", "吴会计（财务）", "finance", "13800000010");
  const family1 = addUser("family1", "family123", "张强（家属）", "family", "13911110001");
  const family2 = addUser("family2", "family123", "刘洋（家属）", "family", "13911110002");

  // ---- 房间 ----
  const addRoom = (number: string, type: string, floor: string, status = "vacant") =>
    Number(ins("INSERT INTO rooms(number,type,floor,status) VALUES(?,?,?,?)", number, type, floor, status).lastInsertRowid);
  const r801 = addRoom("801", "VIP套房", "8F", "occupied");
  const r802 = addRoom("802", "豪华间", "8F", "cleaning");
  addRoom("803", "VIP套房", "8F", "vacant");
  const r901 = addRoom("901", "标准间", "9F", "occupied");
  addRoom("902", "标准间", "9F", "vacant");
  addRoom("903", "标准间", "9F", "vacant");
  addRoom("601", "豪华间", "6F", "vacant");

  // ---- 套餐 ----
  const addPkg = (name: string, days: number, price: number, roomType: string, includes: string, gifts: string[]) =>
    Number(ins("INSERT INTO packages(name,days,price,room_type,includes,gifts) VALUES(?,?,?,?,?,?)",
      name, days, price, roomType, includes, JSON.stringify(gifts)).lastInsertRowid);
  const pkgClassic = addPkg("经典28天套餐", 28, 68800, "标准间",
    "每日三餐三点月子餐、每日查房、宝宝洗澡抚触、夜间照护、基础产康",
    ["待产大礼包", "宝宝艺术照"]);
  const pkgPremium = addPkg("尊享42天套餐", 42, 108800, "豪华间",
    "经典全部 + 乳房护理、产康课程12节、中药足浴、儿科医生每周巡诊",
    ["待产大礼包", "产康体验券", "满月照"]);
  const pkgVip = addPkg("至尊56天套餐", 56, 158800, "VIP套房",
    "尊享全部 + 一对一月嫂、产康课程20节、营养师定制餐、专车接送",
    ["待产大礼包", "产康体验券", "满月照", "金锁礼盒"]);

  // ---- 在住订单 A（801 张女士）----
  const stayA = Number(ins(
    `INSERT INTO stays(code,room_id,package_id,mother_name,mother_phone,delivery_method,postpartum_days,
      allergy_history,feeding_method,meal_taboos,doctor_advice,visit_permissions,
      baby_name,baby_weight,jaundice_level,jaundice_note,status,check_in_date,expected_checkout,created_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    "M20260913-801", r801, pkgPremium, "张丽", "13922220001",
    "剖宫产", 12, "青霉素过敏；海鲜过敏", "混合喂养",
    "忌辛辣、忌海鲜、少油", "注意伤口护理，每日监测黄疸，适当下床活动",
    JSON.stringify({ careSummary: true, fees: true, visits: true, visitors: ["张强（丈夫）", "李秀兰（婆婆）"] }),
    "小宝", 3.4, 12.9, "经皮胆红素偏高，持续观察", "in_stay",
    "2026-09-13", "2026-10-25", front
  ).lastInsertRowid);
  ins("INSERT INTO family_links(stay_id,user_id,name,relation) VALUES(?,?,?,?)", stayA, family1, "张强", "丈夫");

  // ---- 在住订单 B（901 刘女士）----
  const stayB = Number(ins(
    `INSERT INTO stays(code,room_id,package_id,mother_name,mother_phone,delivery_method,postpartum_days,
      allergy_history,feeding_method,meal_taboos,doctor_advice,visit_permissions,
      baby_name,baby_weight,jaundice_level,jaundice_note,status,check_in_date,expected_checkout,created_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    "M20260905-901", r901, pkgClassic, "刘敏", "13922220002",
    "顺产", 20, "无", "母乳喂养",
    "忌生冷", "加强盆底肌训练，注意营养均衡",
    JSON.stringify({ careSummary: true, fees: true, visits: true, visitors: ["刘洋（丈夫）"] }),
    "朵朵", 3.1, 8.2, "黄疸正常范围", "in_stay",
    "2026-09-05", "2026-10-03", front
  ).lastInsertRowid);
  ins("INSERT INTO family_links(stay_id,user_id,name,relation) VALUES(?,?,?,?)", stayB, family2, "刘洋", "丈夫");

  // ---- 已出所订单 C（802 王女士）----
  const stayC = Number(ins(
    `INSERT INTO stays(code,room_id,package_id,mother_name,mother_phone,delivery_method,postpartum_days,
      allergy_history,feeding_method,meal_taboos,doctor_advice,visit_permissions,
      baby_name,baby_weight,jaundice_level,jaundice_note,status,check_in_date,expected_checkout,actual_checkout,created_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    "M20260801-802", r802, pkgClassic, "王雪", "13922220003",
    "顺产", 5, "芒果过敏", "母乳喂养",
    "忌芒果、忌生冷", "正常休养",
    JSON.stringify({ careSummary: true, fees: true, visits: true, visitors: ["丈夫"] }),
    "豆豆", 3.3, 7.5, "正常", "checked_out",
    "2026-08-01", "2026-08-29", "2026-08-29", front
  ).lastInsertRowid);

  // ---- 护理计划（A）----
  const addPlan = (stayId: number, type: string, title: string, freq: string, assignee: number | null, note = "") =>
    Number(ins("INSERT INTO care_plans(stay_id,type,title,frequency,assignee_id,note) VALUES(?,?,?,?,?,?)",
      stayId, type, title, freq, assignee, note).lastInsertRowid);
  const pRounds = addPlan(stayA, "rounds", "护理查房", "每日2次", nurse1);
  const pWound = addPlan(stayA, "wound", "伤口观察（剖宫产）", "每日1次", nurse1, "观察切口愈合与渗液");
  const pBreast = addPlan(stayA, "breast", "乳房护理", "每日1次", nurse2, "预防乳腺堵塞");
  const pRecovery = addPlan(stayA, "recovery", "产康课程", "每周3次", therapist);
  const pMeal = addPlan(stayA, "meal", "月子餐", "每日三餐三点", nutrition, "忌辛辣海鲜");
  const pBath = addPlan(stayA, "baby_bath", "宝宝洗澡抚触", "每日1次", nurse2);
  const pNight = addPlan(stayA, "night_care", "夜间照护", "每日 20:00-08:00", matron);
  addPlan(stayB, "rounds", "护理查房", "每日2次", nurse2);
  addPlan(stayB, "breast", "乳房护理", "每日1次", nurse1);
  addPlan(stayB, "meal", "月子餐", "每日三餐三点", nutrition, "忌生冷");
  addPlan(stayB, "baby_bath", "宝宝洗澡抚触", "每日1次", nurse1);
  addPlan(stayB, "night_care", "夜间照护", "每日 20:00-08:00", matron);
  addPlan(stayB, "recovery", "盆底肌修复课程", "每周2次", therapist);

  // ---- 今日护理任务（A/B）----
  const addTask = (stayId: number, planId: number | null, type: string, title: string, at: string,
    assignee: number | null, status = "pending", record = "", visible = 1) =>
    Number(ins(`INSERT INTO care_tasks(stay_id,plan_id,type,title,scheduled_at,assignee_id,status,done_at,record,visible_to_family)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
      stayId, planId, type, title, at, assignee, status,
      status === "done" ? at : null, record, visible).lastInsertRowid);
  const t1 = addTask(stayA, pRounds, "rounds", "晨间查房", "2026-09-25 08:30", nurse1, "done", "体温36.7℃，血压正常，恶露量少。");
  const t2 = addTask(stayA, pWound, "wound", "伤口观察", "2026-09-25 09:00", nurse1, "done", "切口干燥无渗液，愈合良好。", 0);
  const t3 = addTask(stayA, pBreast, "breast", "乳房护理", "2026-09-25 10:00", nurse2, "done", "右侧轻微胀硬，已热敷按摩。");
  addTask(stayA, pMeal, "meal", "午餐配送与忌口核对", "2026-09-25 11:30", nutrition, "pending");
  addTask(stayA, pBath, "baby_bath", "宝宝洗澡抚触", "2026-09-25 15:00", nurse2, "pending");
  const tNight = addTask(stayA, pNight, "night_care", "夜间照护（9-24夜）", "2026-09-24 20:00", matron, "done", "夜间哺乳3次，宝宝睡眠安稳。");
  addTask(stayA, pRounds, "rounds", "晚间查房", "2026-09-25 20:30", nurse1, "pending");
  addTask(stayB, null, "rounds", "晨间查房", "2026-09-25 08:30", nurse2, "done", "一般情况好。");
  addTask(stayB, null, "baby_bath", "宝宝洗澡抚触", "2026-09-25 15:30", nurse1, "pending");
  addTask(stayB, null, "night_care", "夜间照护（9-25夜）", "2026-09-25 20:00", matron, "pending");

  // ---- 护理记录（A）----
  const addRecord = (stayId: number, taskId: number | null, type: string, content: string,
    by: number, byName: string, visible = 1, disputed = 0, at: string | null = null) =>
    Number(ins(`INSERT INTO care_records(stay_id,task_id,type,content,created_by,created_by_name,visible_to_family,disputed,created_at)
      VALUES(?,?,?,?,?,?,?,?,COALESCE(?, datetime('now','localtime')))`,
      stayId, taskId, type, content, by, byName, visible, disputed, at).lastInsertRowid);
  addRecord(stayA, t1, "rounds", "晨间查房：体温36.7℃，血压110/70，恶露量少色淡。", nurse1, "王芳（护理师）", 1, 0, "2026-09-25 08:40:00");
  addRecord(stayA, t2, "wound", "伤口观察：剖宫产切口干燥，无红肿渗液，换药一次。", nurse1, "王芳（护理师）", 0, 0, "2026-09-25 09:10:00");
  addRecord(stayA, t3, "breast", "乳房护理：右侧外上象限轻胀硬，热敷+手法疏通15分钟，嘱多亲喂。", nurse2, "李婷（护理师）", 1, 0, "2026-09-25 10:20:00");
  addRecord(stayA, tNight, "night_care", "夜间照护：哺乳3次，换尿布4次，宝宝23:00-05:00连续睡眠。", matron, "王嫂（月嫂）", 1, 1, "2026-09-25 08:00:00");
  addRecord(stayA, null, "baby", "宝宝经皮胆红素测定12.9mg/dL，较前上升，已报儿科医生。", nurse1, "王芳（护理师）", 1, 0, "2026-09-25 09:30:00");

  // ---- 月子餐 ----
  const addMeal = (stayId: number, date: string, type: string, menu: string, hits = "", status = "confirmed", note = "") =>
    Number(ins("INSERT INTO meals(stay_id,meal_date,meal_type,menu,taboo_hits,status,note,created_by) VALUES(?,?,?,?,?,?,?,?)",
      stayId, date, type, menu, hits, status, note, nutrition).lastInsertRowid);
  addMeal(stayA, "2026-09-25", "早餐", "小米南瓜粥、蒸蛋羹、全麦馒头、温牛奶");
  addMeal(stayA, "2026-09-25", "午餐", "山药排骨汤、清蒸鲈鱼、时蔬、软米饭");
  addMeal(stayA, "2026-09-25", "晚餐", "虾仁滑蛋、菠菜猪肝汤、软米饭", "海鲜（虾仁）", "issue", "家属反馈产妇海鲜过敏，已登记异常");
  addMeal(stayB, "2026-09-25", "午餐", "当归鸡汤、清炒时蔬、杂粮饭");
  addMeal(stayB, "2026-09-25", "晚餐", "鲫鱼豆腐汤、西兰花、软米饭");

  // ---- 探访 ----
  const addVisit = (stayId: number, name: string, relation: string, time: string, hours: number,
    isTemp: number, status: string, disinfected = 0, note = "") =>
    Number(ins(`INSERT INTO visits(stay_id,visitor_name,relation,visit_time,hours,is_temp,status,disinfected,disinfection_note,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
      stayId, name, relation, time, hours, isTemp, status, disinfected, note, family1).lastInsertRowid);
  addVisit(stayA, "李秀兰", "婆婆", "2026-09-25 10:00", 2, 0, "completed", 1, "入所前手部消毒+测温正常");
  addVisit(stayA, "张强", "丈夫", "2026-09-26 14:00", 3, 0, "approved");
  addVisit(stayB, "刘洋", "丈夫", "2026-09-25 19:00", 2, 1, "pending");

  // ---- 费用 ----
  const addFee = (stayId: number, type: string, amount: number, desc: string, direction = "charge", by: number = finance, at: string | null = null) =>
    Number(ins(`INSERT INTO fees(stay_id,type,direction,amount,description,status,created_by,created_at)
      VALUES(?,?,?,?,?,'confirmed',?,COALESCE(?, datetime('now','localtime')))`,
      stayId, type, direction, amount, desc, by, at).lastInsertRowid);
  addFee(stayA, "package", 108800, "尊享42天套餐费用", "charge", finance, "2026-09-13 10:00:00");
  addFee(stayA, "deposit", 10000, "入住押金", "charge", finance, "2026-09-13 10:00:00");
  addFee(stayA, "extra", 380, "中药足浴（9-20）", "charge", finance, "2026-09-20 15:00:00");
  addFee(stayA, "extra", 580, "宝宝满月照加拍", "charge", finance, "2026-09-24 11:00:00");
  addFee(stayB, "package", 68800, "经典28天套餐费用", "charge", finance, "2026-09-05 09:00:00");
  addFee(stayB, "deposit", 8000, "入住押金", "charge", finance, "2026-09-05 09:00:00");
  addFee(stayC, "package", 68800, "经典28天套餐费用", "charge", finance, "2026-08-01 09:00:00");
  addFee(stayC, "deposit", 8000, "入住押金", "charge", finance, "2026-08-01 09:00:00");
  addFee(stayC, "extra", 1280, "产康加项（骨盆修复2次）", "charge", finance, "2026-08-15 10:00:00");
  addFee(stayC, "refund", 8000, "出所退还押金", "refund", finance, "2026-08-29 15:00:00");

  // ---- 赠品 ----
  const addGift = (stayId: number, name: string, status: string, at: string | null = null) =>
    Number(ins("INSERT INTO gifts(stay_id,name,source,status,delivered_at,delivered_by) VALUES(?,?,?,?,?,?)",
      stayId, name, "package", status, at, status === "delivered" ? front : null).lastInsertRowid);
  addGift(stayA, "待产大礼包", "delivered", "2026-09-13 11:00:00");
  addGift(stayA, "产康体验券", "pending");
  addGift(stayA, "满月照", "pending");
  addGift(stayB, "待产大礼包", "delivered", "2026-09-05 10:00:00");
  addGift(stayB, "宝宝艺术照", "pending");

  // ---- 产康排班 ----
  const addSched = (stayId: number, therapistId: number, project: string, at: string, status = "scheduled", reason = "") =>
    Number(ins("INSERT INTO therapist_schedules(stay_id,therapist_id,project,scheduled_at,status,delay_reason) VALUES(?,?,?,?,?,?)",
      stayId, therapistId, project, at, status, reason).lastInsertRowid);
  addSched(stayA, therapist, "盆底肌修复（第3节）", "2026-09-26 10:00");
  addSched(stayA, therapist, "腹直肌修复（第2节）", "2026-09-28 10:00");
  addSched(stayB, therapist, "盆底肌修复（第1节）", "2026-09-24 14:00", "delayed", "产康师临时外出培训，改期至9-27");

  // ---- 宝宝托管日志 ----
  const addHosting = (stayId: number, baby: string, type: string, start: string, end: string | null, cgId: number, cgName: string, notes: string) =>
    Number(ins("INSERT INTO hosting_logs(stay_id,baby_name,type,start_time,end_time,caregiver_id,caregiver_name,notes) VALUES(?,?,?,?,?,?,?,?)",
      stayId, baby, type, start, end, cgId, cgName, notes).lastInsertRowid);
  addHosting(stayA, "小宝", "夜间托管", "2026-09-24 20:00", "2026-09-25 08:00", matron, "王嫂（月嫂）", "夜间哺乳3次，睡眠安稳");
  addHosting(stayA, "小宝", "洗澡抚触", "2026-09-24 15:00", "2026-09-24 15:40", nurse2, "李婷（护理师）", "水温38℃，抚触15分钟，宝宝配合");
  addHosting(stayB, "朵朵", "托管", "2026-09-25 09:00", "2026-09-25 11:00", nurse1, "王芳（护理师）", "产妇休息时宝宝托管观察");

  // ---- 医生巡诊 ----
  const addRound = (stayId: number, date: string, findings: string, advice: string) =>
    Number(ins("INSERT INTO doctor_rounds(stay_id,doctor_id,doctor_name,round_date,findings,advice) VALUES(?,?,?,?,?,?)",
      stayId, doctor, "陈立（儿科医生）", date, findings, advice).lastInsertRowid);
  addRound(stayA, "2026-09-24", "宝宝经皮胆红素12.9mg/dL，精神吃奶可；产妇切口愈合良好。", "继续监测黄疸每日2次，必要时蓝光治疗；加强喂养。");
  addRound(stayB, "2026-09-23", "宝宝黄疸8.2mg/dL正常，脐部干燥。", "常规护理，按时接种疫苗。");

  // ---- 异常事件 ----
  const addException = (stayId: number, type: string, title: string, desc: string, severity: string,
    status: string, raisedBy: number, raisedName: string, assignedRole: string,
    syncedHeadNurse = 0, resolution = "", at: string | null = null) =>
    Number(ins(`INSERT INTO exceptions(stay_id,type,title,description,severity,status,raised_by,raised_by_name,assigned_role,synced_head_nurse,resolution,created_at,updated_at,resolved_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,COALESCE(?,datetime('now','localtime')),COALESCE(?,datetime('now','localtime')),?)`,
      stayId, type, title, desc, severity, status, raisedBy, raisedName, assignedRole, syncedHeadNurse,
      resolution, at, at, status === "resolved" || status === "closed" ? at : null).lastInsertRowid);
  const addEvent = (exId: number, userId: number, userName: string, action: string, note: string, at: string | null = null) =>
    ins(`INSERT INTO exception_events(exception_id,user_id,user_name,action,note,created_at)
      VALUES(?,?,?,?,?,COALESCE(?,datetime('now','localtime')))`,
      exId, userId, userName, action, note, at);

  const ex1 = addException(stayA, "jaundice", "宝宝黄疸值升至12.9mg/dL", "晨间测定经皮胆红素12.9mg/dL，较前日11.2上升，需儿科评估。", "high", "processing", nurse1, "王芳（护理师）", "pediatrician", 1, "", "2026-09-25 09:35:00");
  addEvent(ex1, nurse1, "王芳（护理师）", "created", "晨测黄疸升高，上报儿科医生并同步护士长。", "2026-09-25 09:35:00");
  addEvent(ex1, doctor, "陈立（儿科医生）", "accepted", "已查看宝宝，建议加强喂养、日光照射，下午复测，必要时蓝光。", "2026-09-25 10:10:00");

  const ex2 = addException(stayA, "meal_taboo", "晚餐含虾仁，与忌口（海鲜）冲突", "家属发现晚餐虾仁滑蛋含海鲜，产妇海鲜过敏，立即停止食用并更换。", "high", "open", family1, "张强（家属）", "nutritionist", 1, "", "2026-09-25 18:05:00");
  addEvent(ex2, family1, "张强（家属）", "created", "晚餐发现虾仁，产妇海鲜过敏，请中心核实处理。", "2026-09-25 18:05:00");

  const ex3 = addException(stayA, "record_dispute", "家属质疑9-24夜间照护记录", "家属认为夜间照护记录中哺乳次数与实际不符，要求核查监控与当班月嫂。", "high", "open", family1, "张强（家属）", "head_nurse", 1, "", "2026-09-25 09:00:00");
  addEvent(ex3, family1, "张强（家属）", "created", "对9-24夜间照护记录真实性提出质疑。", "2026-09-25 09:00:00");

  const ex4 = addException(stayB, "matron_leave", "月嫂王嫂申请9-26至9-27事假", "月嫂家中有事申请两天假，需安排夜间照护替班。", "medium", "processing", matron, "王嫂（月嫂）", "head_nurse", 1, "", "2026-09-25 08:30:00");
  addEvent(ex4, matron, "王嫂（月嫂）", "created", "申请9-26、9-27事假两天。", "2026-09-25 08:30:00");
  addEvent(ex4, headNurse, "周敏（护士长）", "accepted", "已知悉，正在协调替班月嫂。", "2026-09-25 09:00:00");

  const ex5 = addException(stayB, "project_delay", "盆底肌修复课程延期", "产康师9-24外出培训，课程改期至9-27 14:00。", "low", "resolved", therapist, "孙倩（产康师）", "therapist", 0, "已与产妇沟通改期至9-27 14:00，家属知悉。", "2026-09-24 13:00:00");
  addEvent(ex5, therapist, "孙倩（产康师）", "created", "因培训需延期课程。", "2026-09-24 13:00:00");
  addEvent(ex5, therapist, "孙倩（产康师）", "resolved", "已改期并通知产妇。", "2026-09-24 15:00:00");

  const ex6 = addException(stayC, "checkout_dispute", "退所押金结算争议", "家属对产康加项费用1280元有异议，认为未提前告知价格。", "high", "resolved", admin, "沈总", "finance", 1, "核实价目表已公示，考虑客户体验减免640元，家属接受。", "2026-08-29 14:00:00");
  addEvent(ex6, admin, "沈总", "created", "退所结算时家属对加项费用提出异议。", "2026-08-29 14:00:00");
  addEvent(ex6, finance, "吴会计（财务）", "note", "提供价目公示照片与签字确认单。", "2026-08-29 14:30:00");
  addEvent(ex6, headNurse, "周敏（护士长）", "resolved", "减免50%加项费用，家属签字确认，争议关闭。", "2026-08-29 15:00:00");

  // ---- 家属反馈 ----
  const addFeedback = (stayId: number, userId: number | null, userName: string, rating: number, content: string,
    status = "new", response = "", affect = 0, at: string | null = null) =>
    Number(ins(`INSERT INTO feedbacks(stay_id,user_id,user_name,rating,content,status,response,affect_scheduling,created_at)
      VALUES(?,?,?,?,?,?,?,?,COALESCE(?,datetime('now','localtime')))`,
      stayId, userId, userName, rating, content, status, response, affect, at).lastInsertRowid);
  addFeedback(stayA, family1, "张强（家属）", 4, "整体满意，希望夜间呼叫响应再快一些。", "new", "", 0, "2026-09-24 20:00:00");
  addFeedback(stayB, family2, "刘洋（家属）", 2, "月子餐出现过忌口食材，对餐饮不放心，希望更换配餐责任人。", "responded", "非常抱歉，已核对配餐流程并更换责任营养师，今日起每餐双人核对忌口。", 1, "2026-09-23 19:00:00");
  addFeedback(stayC, null, "王雪（家属）", 5, "28天体验很好，月嫂和护士都很专业，已推荐给朋友。", "responded", "感谢认可，已为您登记转介绍礼遇。", 0, "2026-08-29 16:00:00");

  // ---- 随访 / 回访 ----
  const addFollowUp = (stayId: number, type: string, at: string, content: string, status = "pending", result = "") =>
    Number(ins("INSERT INTO follow_ups(stay_id,type,scheduled_at,content,status,result,created_by,done_at) VALUES(?,?,?,?,?,?,?,?)",
      stayId, type, at, content, status, result, headNurse, status === "done" ? at : null).lastInsertRowid);
  addFollowUp(stayC, "回访", "2026-09-01 10:00", "出所后3天电话回访", "done", "产妇恢复良好，宝宝黄疸已退，对服务满意。");
  addFollowUp(stayC, "母婴随访", "2026-09-29 10:00", "出所后1个月母婴随访（儿保+产康复查提醒）");
  addFollowUp(stayA, "回访", "2026-09-28 10:00", "住中满意度回访");

  // ---- 复购 / 转介绍线索 ----
  const addReferral = (stayId: number, kind: string, name: string, phone: string, note: string, status = "new") =>
    Number(ins("INSERT INTO referrals(stay_id,kind,lead_name,lead_phone,note,status) VALUES(?,?,?,?,?,?)",
      stayId, kind, name, phone, note, status).lastInsertRowid);
  addReferral(stayC, "referral", "赵女士", "13933330001", "王女士转介绍，孕24周，意向42天套餐", "following");
  addReferral(stayC, "repurchase", "王雪", "13922220003", "咨询二胎月子房老客优惠", "new");

  // ---- 结算单（C 已确认）----
  ins(`INSERT INTO settlements(stay_id,total_charge,total_refund,paid,balance,detail,status,confirmed_by,confirmed_at)
    VALUES(?,?,?,?,?,?,?,?,?)`,
    stayC, 70080, 8000, 70080, 0,
    "套餐68800 + 产康加项1280 - 争议减免640 = 应收69440；押金8000退还；实收70080（含押金抵扣）",
    "confirmed", finance, "2026-08-29 15:30:00");

  // ---- 家属沟通 ----
  const addMessage = (stayId: number, userId: number | null, name: string, role: string, audience: string, content: string, at: string | null = null) =>
    ins(`INSERT INTO messages(stay_id,from_user_id,from_name,from_role,audience,content,created_at)
      VALUES(?,?,?,?,?,?,COALESCE(?,datetime('now','localtime')))`,
      stayId, userId, name, role, audience, content, at);
  addMessage(stayA, front, "小钱（前台）", "frontdesk", "all", "已为您预约9-26 10:00盆底肌修复课程。", "2026-09-24 16:00:00");
  addMessage(stayA, family1, "张强（家属）", "family", "staff", "请问明天下午可以增加一次探访吗？孩子奶奶想来看看。", "2026-09-25 09:20:00");
  addMessage(stayB, family2, "刘洋（家属）", "family", "staff", "今晚我下班后想临时过来看一下，大概19:00到。", "2026-09-25 12:00:00");

  // ---- 审计日志 ----
  const addAudit = (stayId: number | null, actorId: number | null, actor: string, action: string, detail: string, at: string | null = null) =>
    ins(`INSERT INTO audit_logs(stay_id,actor_id,actor_name,action,detail,created_at)
      VALUES(?,?,?,?,?,COALESCE(?,datetime('now','localtime')))`,
      stayId, actorId, actor, action, detail, at);
  addAudit(stayA, front, "小钱（前台）", "入住登记", "张丽入住801（尊享42天套餐），建立护理计划7项", "2026-09-13 10:00:00");
  addAudit(stayA, finance, "吴会计（财务）", "费用登记", "套餐费用108800元、押金10000元", "2026-09-13 10:05:00");
  addAudit(stayA, nurse1, "王芳（护理师）", "护理记录", "晨间查房完成，宝宝黄疸复测12.9mg/dL", "2026-09-25 09:35:00");
  addAudit(stayA, family1, "张强（家属）", "家属沟通", "家属申请增加探访并质疑夜间照护记录", "2026-09-25 09:20:00");
  addAudit(stayB, matron, "王嫂（月嫂）", "月嫂请假", "申请9-26至9-27事假，待护士长协调替班", "2026-09-25 08:30:00");
  addAudit(stayC, finance, "吴会计（财务）", "出所结算", "结算完成：应收69440，退还押金8000，无欠费", "2026-08-29 15:30:00");

  // ---- 宝宝黄疸分级处置与转诊闭环 ----
  // 案例1（801）：加强复测→医生当班评估确认→加强复测监测中（家属可见的仅为医生确认建议）
  const jc1 = Number(ins(
    `INSERT INTO jaundice_cases(stay_id,code,level,status,risk_note,escalated_head_nurse,prior_plan,
      doctor_advice,advice_visible_to_family,advice_by,advice_by_name,advice_confirmed_at,
      created_by,created_by_name,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    stayA, "JC-20260925-801", "doctor", "monitoring", "", 0,
      "既往观察计划：经皮胆红素每日09:00/18:00各测1次；加强喂养、多吃多排；日光照射每日2次每次20分钟；异常上升立即报儿科医生。",
      "宝宝目前一般情况好、吃奶有力，考虑生理性黄疸高峰期，按加强复测处理：今日15:00加测一次经皮胆红素，继续加强喂养与日光照射；若继续上升或超过15mg/dL立即转医生当班评估，必要时蓝光或转诊。",
      1, doctor, "陈立（儿科医生）", "2026-09-25 10:15:00",
      nurse1, "王芳（护理师）", "2026-09-25 09:36:00", "2026-09-25 10:15:00"
  ).lastInsertRowid);
  const addJMeas = (caseId: number, stayId: number, at: string, method: string, value: number, trend: string,
    feeding: string, stool: string, urine: string, by: number, byName: string, note = "") =>
    ins(`INSERT INTO jaundice_measurements(case_id,stay_id,measured_at,method,value,trend,feeding,stool,urine,note,measured_by,measured_by_name,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      caseId, stayId, at, method, value, trend, feeding, stool, urine, note, by, byName, at);
  const addJEvt = (caseId: number, stayId: number, type: string, by: number | null, byName: string, role: string, detail: string, at: string) =>
    ins(`INSERT INTO jaundice_events(case_id,stay_id,event_type,actor_id,actor_name,actor_role,detail,created_at)
      VALUES(?,?,?,?,?,?,?,?)`, caseId, stayId, type, by, byName, role, detail, at);
  const addJTodo = (caseId: number, stayId: number, kind: string, title: string, due: string,
    assignee: number | null, assigneeName: string, status: string, cancelReason = "", doneAt: string | null = null) =>
    ins(`INSERT INTO jaundice_todos(case_id,stay_id,kind,title,due_at,assignee_id,assignee_name,status,cancel_reason,done_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, caseId, stayId, kind, title, due, assignee, assigneeName, status, cancelReason, doneAt);

  addJMeas(jc1, stayA, "2026-09-24 09:30", "TCB", 11.2, "持平", "混合喂养，每3小时1次，吃奶好", "胎便已转黄，每日4次", "每日6次以上", nurse1, "王芳（护理师）", "晨测");
  addJMeas(jc1, stayA, "2026-09-25 09:30", "TCB", 12.9, "上升", "混合喂养，吃奶好，今日已喂6次", "黄色稀便5次", "每日7次", nurse1, "王芳（护理师）", "较前日+1.7，按阈值进入医生当班评估");
  addJEvt(jc1, stayA, "reported", nurse1, "王芳（护理师）", "nurse", "晨测TCB 12.9mg/dL较前上升，平台按阈值分级为「医生当班评估」，已通知儿科医生并同步护士长。", "2026-09-25 09:36:00");
  addJEvt(jc1, stayA, "triaged", null, "系统", "system", "依据阈值（TCB 12.0–14.9 且呈上升）分级：医生当班评估；医生确认前家属端仅提示观察中。", "2026-09-25 09:36:00");
  addJEvt(jc1, stayA, "doctor_confirmed", doctor, "陈立（儿科医生）", "pediatrician", "医生当班查看宝宝，确认处理建议（加强复测+加强喂养，达到指征再转诊），建议已对家属可见。", "2026-09-25 10:15:00");
  addJTodo(jc1, stayA, "remeasure", "15:00 加测经皮胆红素并记录喂养/排泄", "2026-09-25 15:00", nurse1, "王芳（护理师）", "pending");
  addJTodo(jc1, stayA, "remeasure", "18:00 晚间黄疸复测", "2026-09-25 18:00", nurse1, "王芳（护理师）", "pending");

  // 案例2（901）：紧急转诊——家属已确认、交接已备，车辆拒绝导致延迟，自动升级护士长并保留风险说明
  const jc2 = Number(ins(
    `INSERT INTO jaundice_cases(stay_id,code,level,status,risk_note,escalated_head_nurse,escalate_reason,escalated_at,prior_plan,
      doctor_advice,advice_visible_to_family,advice_by,advice_by_name,advice_confirmed_at,referral_reason,
      family_decision,family_decision_by,family_decision_name,family_decision_at,
      vehicle,vehicle_status,escort,escort_status,target_hospital,handover_content,handover_by,handover_by_name,
      created_by,created_by_name,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    stayB, "JC-20260925-901", "urgent", "upgraded",
      "【转诊延迟风险】平台合作转运车14:35反馈约满无法派出、120急救车辆暂无空车，距家属确认转诊已约20分钟未能出发；已自动升级护士长协调备用车辆，期间持续监测黄疸与生命体征，每15分钟复测一次。",
      1, "车辆拒绝派车导致转诊延迟，系统自动升级护士长", "2026-09-25 14:40:00",
      "既往观察计划：纯母乳喂养，TCB每日1次；9-23巡诊8.2mg/dL在正常范围，常规观察。",
      "宝宝TCB 18.6mg/dL且24小时内快速上升，颜面至躯干四肢黄染明显，符合紧急转诊光疗指征；建议立即转市儿童医院新生儿科评估并准备蓝光治疗，途中由护理师陪同、保持气道通畅、适当喂养。",
      1, doctor, "陈立（儿科医生）", "2026-09-25 14:20:00",
      "TCB 18.6mg/dL，上升速度快、黄染范围广，达到紧急转诊光疗指征。",
      "agree", family2, "刘洋（家属）", "2026-09-25 14:25:00",
      "中心合作转运车（协调中：车辆拒绝）", "车辆拒绝", "李婷（护理师）", "已协调",
      "市儿童医院 新生儿科",
      "交接材料：宝宝朵朵，女，出生20天，纯母乳喂养；近24小时TCB由13.8升至18.6mg/dL；无发热、抽搐，吃奶尚可，今日小便6次、大便4次；已带：接种本、母婴手册、近3日黄疸记录、喂养排泄记录、家长身份证件复印件；医嘱：转诊光疗。",
      nurse2, "李婷（护理师）",
      nurse2, "李婷（护理师）", "2026-09-25 14:05:00", "2026-09-25 14:40:00"
  ).lastInsertRowid);
  addJMeas(jc2, stayB, "2026-09-24 18:00", "TCB", 13.8, "上升", "纯母乳喂养，吃奶好", "黄便3次", "小便5次", nurse2, "李婷（护理师）");
  addJMeas(jc2, stayB, "2026-09-25 14:00", "TCB", 18.6, "上升", "纯母乳，吃奶稍频，偶有嗜睡", "黄便4次", "小便6次", nurse2, "李婷（护理师）", "四肢黄染，立即上报");
  addJEvt(jc2, stayB, "reported", nurse2, "李婷（护理师）", "nurse", "测得TCB 18.6mg/dL、24h内明显上升，按阈值分级「紧急转诊」，立即通知医生当班并同步护士长。", "2026-09-25 14:05:00");
  addJEvt(jc2, stayB, "triaged", null, "系统", "system", "依据阈值（TCB ≥15 或 TSB ≥18 或快速上升）分级：紧急转诊。", "2026-09-25 14:05:00");
  addJEvt(jc2, stayB, "doctor_confirmed", doctor, "陈立（儿科医生）", "pediatrician", "医生确认紧急转诊建议，目标医院市儿童医院新生儿科；建议同步家属端。", "2026-09-25 14:20:00");
  addJEvt(jc2, stayB, "family_confirmed", family2, "刘洋（家属）", "family", "家属确认转诊，同意中心协调车辆并由护理师陪同。", "2026-09-25 14:25:00");
  addJEvt(jc2, stayB, "coordinated", nurse2, "李婷（护理师）", "nurse", "已确定陪同护理师李婷、目标医院市儿童医院新生儿科，护理交接材料已备齐（黄疸记录、喂养排泄记录、证件复印件）。", "2026-09-25 14:30:00");
  addJEvt(jc2, stayB, "vehicle_declined", null, "系统", "system", "合作转运车回复约满无法派出、120暂无空车，转诊未能按时出发。", "2026-09-25 14:35:00");
  addJEvt(jc2, stayB, "escalated", null, "系统", "system", "车辆拒绝导致转诊延迟，自动升级护士长周敏，生成风险说明并要求尽快协调备用车辆。", "2026-09-25 14:40:00");
  addJTodo(jc2, stayB, "coordinate", "【护士长】协调备用车辆并记录出发时间", "2026-09-25 15:00", headNurse, "周敏（护士长）", "pending");
  addJTodo(jc2, stayB, "coordinate", "转诊途中持续监测，到达后回传接收情况", "2026-09-25 15:30", nurse2, "李婷（护理师）", "pending");
  ins(`INSERT INTO exceptions(stay_id,type,title,description,severity,status,raised_by,raised_by_name,assigned_role,synced_head_nurse,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    stayB, "jaundice", "宝宝黄疸18.6mg/dL，紧急转诊（车辆协调延迟已升级）",
    "阈值分级紧急转诊；家属14:25已确认；合作车辆拒绝派车，14:40自动升级护士长。详见黄疸处置闭环 JC-20260925-901。",
    "critical", "processing", nurse2, "李婷（护理师）", "pediatrician", 1, "2026-09-25 14:05:00", "2026-09-25 14:40:00");

  // 案例3（801，已闭环）：转诊→外院回执与原中心计划冲突→医生复核→重建观察计划、取消过期提醒、同步排班
  const pOldJaundice = addPlan(stayA, "jaundice_obs", "黄疸观察（旧·已过期）", "每日1次 09:00", nurse1, "转诊前建立，返中心后已由医生复核重建");
  run("UPDATE care_plans SET status='cancelled' WHERE id=?", pOldJaundice);
  const jc3 = Number(ins(
    `INSERT INTO jaundice_cases(stay_id,code,level,status,risk_note,escalated_head_nurse,prior_plan,
      doctor_advice,advice_visible_to_family,advice_by,advice_by_name,advice_confirmed_at,referral_reason,
      family_decision,family_decision_name,family_decision_at,
      vehicle,vehicle_status,escort,escort_status,target_hospital,handover_content,handover_by,handover_by_name,departed_at,arrived_at,
      hospital_receipt,returned_at,conflict,conflict_detail,review_note,reviewed_by,reviewed_by_name,reviewed_at,routine_resumed_at,
      created_by,created_by_name,created_at,updated_at,closed_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    stayA, "JC-20260919-801", "urgent", "resolved", "", 0,
      "既往观察计划：TCB每日09:00测1次、纯母乳喂养、母乳性黄疸观察、异常报医生。",
      "TCB 17.1mg/dL达转诊指征，建议转市妇幼保健院新生儿科光疗评估。",
      1, doctor, "陈立（儿科医生）", "2026-09-19 10:30:00", "TCB 17.1mg/dL，达光疗转诊指征。",
      "agree", "张强（家属）", "2026-09-19 10:40:00",
      "120急救车", "已协调", "王芳（护理师）", "已协调", "市妇幼保健院 新生儿科",
      "交接材料：宝宝小宝，男，出生约1周，混合喂养；TCB变化11.2→17.1；吃奶可、二便正常；随附黄疸记录与喂养记录。",
      nurse1, "王芳（护理师）", "2026-09-19 11:00:00", "2026-09-19 11:40:00",
      "外院回执：入院诊断新生儿高胆红素血症，蓝光治疗24小时后TCB降至11.0mg/dL，9-21准予出院；带药茵栀黄口服液；外院口头建议暂停母乳喂养72小时；9-23返院复查。",
      "2026-09-22 10:30:00", 1,
      "外院建议「暂停母乳喂养72小时」与本中心原计划「纯母乳喂养、按母乳性黄疸观察」存在冲突；护理师暂未自行调整喂养方案。",
      "复核意见：外院停母乳建议与中心喂养计划冲突，经与外院出院小结核对，调整为混合喂养过渡72小时并加强复测，胆红素稳定下降即恢复母乳喂养；未复核通过前不恢复常规护理。",
      doctor, "陈立（儿科医生）", "2026-09-22 11:00:00", "2026-09-22 14:00:00",
      nurse1, "王芳（护理师）", "2026-09-19 10:20:00", "2026-09-22 14:00:00", "2026-09-22 14:00:00"
  ).lastInsertRowid);
  addJMeas(jc3, stayA, "2026-09-18 09:00", "TCB", 15.6, "上升", "混合喂养", "黄便4次", "小便6次", nurse1, "王芳（护理师）");
  addJMeas(jc3, stayA, "2026-09-19 10:00", "TCB", 17.1, "上升", "混合喂养，吃奶可", "黄便3次", "小便5次", nurse1, "王芳（护理师）", "达转诊指征");
  addJEvt(jc3, stayA, "reported", nurse1, "王芳（护理师）", "nurse", "TCB 17.1mg/dL，分级紧急转诊。", "2026-09-19 10:20:00");
  addJEvt(jc3, stayA, "triaged", null, "系统", "system", "依据阈值分级：紧急转诊。", "2026-09-19 10:20:00");
  addJEvt(jc3, stayA, "doctor_confirmed", doctor, "陈立（儿科医生）", "pediatrician", "确认转诊建议与目标医院。", "2026-09-19 10:30:00");
  addJEvt(jc3, stayA, "family_confirmed", family1, "张强（家属）", "family", "家属确认转诊。", "2026-09-19 10:40:00");
  addJEvt(jc3, stayA, "coordinated", nurse1, "王芳（护理师）", "nurse", "120车辆、陪同护理师、目标医院、交接材料齐备。", "2026-09-19 10:50:00");
  addJEvt(jc3, stayA, "departed", nurse1, "王芳（护理师）", "nurse", "宝宝出发前往市妇幼保健院。", "2026-09-19 11:00:00");
  addJEvt(jc3, stayA, "arrived", nurse1, "王芳（护理师）", "nurse", "到达外院新生儿科并完成交接。", "2026-09-19 11:40:00");
  addJEvt(jc3, stayA, "returned", nurse2, "李婷（护理师）", "nurse", "宝宝光疗后返回中心，提交外院回执；系统识别喂养建议冲突，进入医生复核，暂缓恢复常规护理。", "2026-09-22 10:30:00");
  addJEvt(jc3, stayA, "conflict_flagged", null, "系统", "system", "外院「停母乳72h」与原中心「纯母乳」计划冲突，挂起常规护理待医生复核。", "2026-09-22 10:30:00");
  addJEvt(jc3, stayA, "reviewed", doctor, "陈立（儿科医生）", "pediatrician", "医生复核通过：混合喂养过渡72h+加强复测，稳定后恢复母乳。", "2026-09-22 11:00:00");
  addJEvt(jc3, stayA, "plan_rebuilt", headNurse, "周敏（护士长）", "head_nurse", "依外院回执与医生新建议重建观察计划：取消转诊前过期复测提醒2项，新增过渡喂养期黄疸复测任务，已同步护理师排班。", "2026-09-22 14:00:00");
  addJEvt(jc3, stayA, "routine_resumed", headNurse, "周敏（护士长）", "head_nurse", "复核通过且计划已重建，恢复常规护理，闭环关闭。", "2026-09-22 14:00:00");
  addJTodo(jc3, stayA, "remeasure", "（旧）09-20 09:00 黄疸复测", "2026-09-20 09:00", nurse1, "王芳（护理师）", "cancelled", "宝宝转诊外院，旧观察计划过期取消", null);
  addJTodo(jc3, stayA, "remeasure", "（旧）09-21 09:00 黄疸复测", "2026-09-21 09:00", nurse1, "王芳（护理师）", "cancelled", "返中心后按医生新建议重建计划，旧提醒取消", null);
  addJTodo(jc3, stayA, "review", "凭外院回执由医生复核喂养建议冲突", "2026-09-22 11:00", doctor, "陈立（儿科医生）", "done", "", "2026-09-22 11:00:00");
  addJTodo(jc3, stayA, "remeasure", "过渡喂养期 09-22 16:00 复测TCB", "2026-09-22 16:00", nurse1, "王芳（护理师）", "done", "", "2026-09-22 16:10:00");
  // 复核重建后的观察计划与任务（同步护理师排班）
  const pNewJaundice = Number(ins("INSERT INTO care_plans(stay_id,type,title,frequency,assignee_id,status,note) VALUES(?,?,?,?,?,?,?)",
    stayA, "jaundice_obs", "黄疸加强复测（外院返中心·医生复核版）", "过渡72h内每12h1次，之后每日1次", nurse1, "active",
    "混合喂养过渡72h，胆红素稳定后恢复母乳；依据JC-20260919-801复核意见重建").lastInsertRowid);
  ins("INSERT INTO care_tasks(stay_id,plan_id,type,title,scheduled_at,assignee_id,status,done_at,record,visible_to_family) VALUES(?,?,?,?,?,?,?,?,?,?)",
    stayA, pNewJaundice, "jaundice_obs", "黄疸复测（复核重建计划）", "2026-09-23 08:30", nurse1, "done", "2026-09-23 08:30", "TCB 10.2mg/dL，继续下降，混合喂养过渡中。", 1);

  console.log("[db] seeded demo data");
}
