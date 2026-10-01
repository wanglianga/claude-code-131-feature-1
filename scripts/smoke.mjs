// 冒烟测试：登录各角色 → 访问工作台 → 执行关键业务动作
// 用法：先启动服务（npm start 或 npm run dev），再执行 npm run smoke
const BASE = process.env.SMOKE_BASE || "http://localhost:3000";

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "login", username, password }),
  });
  const body = await res.json();
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return { ok: body.ok, cookie, user: body.user };
}

async function get(path, cookie) {
  const res = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie }, redirect: "manual" });
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get("location") || "" };
}

async function doAction(cookie, payload) {
  const res = await fetch(`${BASE}/api/do`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(payload),
  });
  return res.json();
}

console.log(`smoke against ${BASE}`);

// 1. 登录页可访问
{
  const r = await get("/login", "");
  check("登录页可访问", r.status === 200 && r.text.includes("悦安月子中心"));
}

// 2. 错误密码被拒绝
{
  const r = await login("admin", "wrong-password");
  check("错误密码拒绝登录", r.ok === false);
}

// 3. 各角色登录并进入工作台
const roles = [
  ["admin", "admin123", "/admin", "房间实时看板"],
  ["headnurse", "head123", "/headnurse", "异常工单中心"],
  ["nurse1", "nurse123", "/nurse", "护理任务"],
  ["doctor", "doc123", "/doctor", "黄疸预警"],
  ["nutrition", "nut123", "/nutritionist", "忌口"],
  ["therapist", "the123", "/therapist", "产康排班"],
  ["matron", "mat123", "/nurse", "月嫂工作台"],
  ["front", "front123", "/frontdesk", "入住登记"],
  ["finance", "fin123", "/finance", "结算单"],
  ["family1", "family123", "/family", "护理摘要"],
];
const cookies = {};
for (const [u, p, home, marker] of roles) {
  const r = await login(u, p);
  check(`${u} 登录`, r.ok === true);
  if (!r.ok) continue;
  cookies[u] = r.cookie;
  const page = await get(home, r.cookie);
  check(`${u} 工作台 ${home} 含「${marker}」`, page.status === 200 && page.text.includes(marker));
}

// 4. 未登录访问受保护页 → 重定向登录
{
  const r = await get("/admin", "");
  check("未登录访问 /admin 重定向", r.status === 307 && r.location.includes("/login"));
}

// 5. 越权访问：家属访问管理看板 → 重定向家属端
{
  const r = await get("/admin", cookies["family1"]);
  check("家属访问 /admin 被重定向", r.status === 307 && r.location.includes("/family"));
}

// 6. 房间360视图（管理员）
{
  const r = await get("/stays/1", cookies["admin"]);
  check("房间360视图含产妇档案与异常工单", r.status === 200 && r.text.includes("产妇与宝宝档案") && r.text.includes("异常工单"));
}

// 7. 护理师完成一项任务
{
  const list = await get("/nurse", cookies["nurse1"]);
  const m = list.text.match(/宝宝洗澡抚触/);
  check("护理师任务列表含待执行任务", !!m);
  // 找一个 pending 任务 id：直接创建再完成
  const c = await doAction(cookies["nurse1"], { action: "tasks.create", stayId: 1, type: "rounds", title: "冒烟测试任务", scheduledAt: "2026-09-25 21:00" });
  check("护理师创建任务", c.ok === true);
  const done = await doAction(cookies["nurse1"], { action: "tasks.update", id: c.id, status: "done", record: "冒烟测试执行记录" });
  check("护理师完成任务并留记录", done.ok === true);
}

// 8. 营养师配餐命中忌口 → 自动建异常
{
  const r = await doAction(cookies["nutrition"], { action: "meals.create", stayId: 1, mealDate: "2026-09-26", mealType: "午餐", menu: "麻辣香锅、虾仁炒饭" });
  check("配餐命中忌口返回警告", r.ok === true && Array.isArray(r.tabooHits) && r.tabooHits.length > 0, JSON.stringify(r));
}

// 9. 家属预约临时探访 → 产生临时探访异常
{
  const r = await doAction(cookies["family1"], { action: "visits.create", stayId: 1, visitorName: "张强", relation: "丈夫", visitTime: "2026-09-26 18:00", hours: 2, isTemp: true });
  check("家属临时探访预约", r.ok === true);
  const admin = await get("/stays/1", cookies["admin"]);
  check("房间360出现临时探访异常", admin.text.includes("家属临时增加探访"));
}

// 10. 家属质疑护理记录
{
  const rec = await doAction(cookies["family1"], { action: "records.dispute", id: 1, reason: "冒烟测试：质疑记录" });
  check("家属质疑护理记录", rec.ok === true);
}

// 11. 家属越权访问他人房间
{
  const r = await doAction(cookies["family1"], { action: "visits.create", stayId: 2, visitorName: "越权测试", visitTime: "2026-09-26 20:00" });
  check("家属访问他人房间被拒绝", r.ok === false);
}

// 12. 前台登记新入住（含家属账号）——动态选取空房，可重复运行
let smokeStayId = null;
let smokeRoomId = null;
{
  const roomsRes = await fetch(`${BASE}/api/rooms`, { headers: { Cookie: cookies["front"] } });
  const roomsBody = await roomsRes.json();
  const vacant = (roomsBody.rooms || []).find((r) => r.status === "vacant");
  check("获取空房列表", !!vacant);
  if (vacant) {
    smokeRoomId = vacant.id;
    const r = await doAction(cookies["front"], {
      action: "stays.create", roomId: vacant.id, packageId: 1, motherName: "冒烟测试产妇", motherPhone: "13900000000",
      checkInDate: "2026-09-25", deliveryMethod: "顺产", postpartumDays: 3, feedingMethod: "母乳喂养",
      mealTaboos: "忌辛辣", babyName: "测测", babyWeight: 3.2, deposit: 5000,
      familyUsername: "smokefam", familyPassword: "smoke123", familyName: "冒烟家属", familyRelation: "丈夫",
    });
    check("前台入住登记", r.ok === true, JSON.stringify(r));
    if (r.ok) {
      smokeStayId = r.id;
      const fam = await login("smokefam", "smoke123");
      check("新家属账号可登录", fam.ok === true);
      const page = await get("/family", fam.cookie);
      check("新家属端显示入住信息", page.status === 200 && page.text.includes("冒烟测试产妇"));
    }
  }
}

// 13. 财务登记费用并走完整出所结算流程
if (smokeStayId) {
  const stays = await get("/finance", cookies["finance"]);
  check("财务工作台可访问", stays.status === 200);
  const fee = await doAction(cookies["finance"], { action: "fees.create", stayId: smokeStayId, type: "extra", direction: "charge", amount: 100, description: "冒烟测试增项" });
  check("财务登记增项费用", fee.ok === true);
  const co = await doAction(cookies["finance"], { action: "stays.checkout", stayId: smokeStayId, reason: "冒烟测试提前退所" });
  check("办理提前退所", co.ok === true, JSON.stringify(co));
  const st = await doAction(cookies["finance"], { action: "settlements.confirm", stayId: smokeStayId });
  check("确认结算", st.ok === true, JSON.stringify(st));
  // 清理：房间恢复空房，保证冒烟可重复运行
  await doAction(cookies["front"], { action: "rooms.update", id: smokeRoomId, status: "vacant" });
}

// 14. 家属反馈 → 护士长回复并标记影响排班
{
  const fb = await doAction(cookies["family1"], { action: "feedbacks.create", stayId: 1, rating: 3, content: "冒烟测试反馈" });
  check("家属提交反馈", fb.ok === true);
  const rp = await doAction(cookies["headnurse"], { action: "feedbacks.respond", id: fb.id, response: "冒烟测试回复", affectScheduling: true });
  check("护士长回复反馈并标记影响排班", rp.ok === true);
}

// 15. 管理员看板能看到费用变化与异常
{
  const r = await get("/admin", cookies["admin"]);
  check("管理看板含高敏感客诉区", r.status === 200 && r.text.includes("高敏感客诉"));
}

// ===== 宝宝黄疸升高分级处置与转诊闭环 =====
// 16. 护理师测得黄疸升高并上报：平台自动阈值分级（加强复测），记录测量时间/方式/趋势/喂养/排泄
let jcEnhanced = null;
{
  const fam2Login = await login("family2", "family123");
  check("family2 登录（901家属）", fam2Login.ok === true);
  if (fam2Login.ok) cookies["family2"] = fam2Login.cookie;
  const r = await doAction(cookies["nurse1"], {
    action: "jaundice.report", stayId: 2, measuredAt: "2026-10-01T09:00",
    method: "TCB", value: 10.5, trend: "上升",
    feeding: "母乳喂养，每2.5小时1次，吃奶好", stool: "黄便4次", urine: "小便6次",
    note: "面部微黄",
  });
  check("黄疸上报成功并自动分级", r.ok === true && r.level === "enhanced", JSON.stringify(r));
  jcEnhanced = r.id;
  const nursePage = await get("/nurse", cookies["nurse1"]);
  check("护理工作台含黄疸分级上报入口", nursePage.text.includes("宝宝黄疸分级处置与转诊闭环"));
}

// 17. 医生确认前：家属端不可见；护理师不得自行转诊/承诺
{
  const famPage = await get("/family", cookies["family2"]);
  check("医生确认前家属端不展示该处置事件", !famPage.text.includes(`JC-20261001-901-${jcEnhanced}`));
  const coord = await doAction(cookies["nurse1"], { action: "jaundice.coordinate", id: jcEnhanced, vehicleResult: "ok" });
  check("护理师在家属确认前不能协调转诊", coord.ok === false);
  const confirmByNurse = await doAction(cookies["nurse1"], { action: "jaundice.doctorConfirm", id: jcEnhanced, decision: "referral", advice: "护士不能确认" });
  check("护理师不能代行医生确认", confirmByNurse.ok === false);
}

// 18. 加强复测继续升高 → 自动上调为医生当班评估；医生确认留观建议后家属端可见
{
  const rm = await doAction(cookies["nurse1"], {
    action: "jaundice.remeasure", id: jcEnhanced, measuredAt: "2026-10-01T12:00",
    method: "TCB", value: 13.0, feeding: "母乳，吃奶好", stool: "黄便3次", urine: "小便5次",
  });
  check("复测升高自动上调为医生当班评估", rm.ok === true && rm.level === "doctor", JSON.stringify(rm));
  const docPage = await get("/doctor", cookies["doctor"]);
  check("医生工作台含待当班确认队列", docPage.text.includes("待医生当班评估确认"));
  const cf = await doAction(cookies["doctor"], {
    action: "jaundice.doctorConfirm", id: jcEnhanced, decision: "monitor",
    advice: "考虑生理性黄疸高峰：6/12小时加强复测，加强喂养多吃多排，继续上升达指征再转诊。",
  });
  check("医生确认加强复测建议", cf.ok === true, JSON.stringify(cf));
  const famPage = await get("/family", cookies["family2"]);
  check("医生确认后家属端仅展示确认建议", famPage.text.includes("考虑生理性黄疸高峰") && famPage.text.includes("宝宝黄疸观察与转诊"));
  check("家属端不暴露内部阈值分级口径", !famPage.text.includes("既往观察计划") && !famPage.text.includes("自动升级护士长"));
}

// 19. 医生改为建议转诊 → 必须家属确认；家属确认后才能协调
let jcId = jcEnhanced;
{
  const ref = await doAction(cookies["doctor"], {
    action: "jaundice.doctorConfirm", id: jcId, decision: "referral",
    advice: "黄疸继续上升，建议立即转上级医院新生儿科评估光疗。", referralReason: "TCB上升至15以上，黄染范围扩大",
  });
  check("医生确认转诊建议并等待家属", ref.ok === true, JSON.stringify(ref));
  const famBefore = await get("/family", cookies["family2"]);
  check("家属端出现转诊确认操作", famBefore.text.includes("医生建议将宝宝转上级医院新生儿科"));
  const nurseCoord = await doAction(cookies["nurse1"], { action: "jaundice.coordinate", id: jcId, vehicleResult: "ok", vehicle: "私车" });
  check("家属确认前协调被拒绝", nurseCoord.ok === false);
  const agree = await doAction(cookies["family2"], { action: "jaundice.familyDecide", id: jcId, decision: "agree", note: "同意转诊" });
  check("家属确认转诊", agree.ok === true, JSON.stringify(agree));
}

// 20. 车辆拒绝导致转诊延迟 → 自动升级护士长并保留风险说明
{
  const dec = await doAction(cookies["nurse1"], {
    action: "jaundice.coordinate", id: jcId, vehicleResult: "declined",
    vehicle: "合作转运车/120", declineNote: "合作车约满、120暂无空车",
  });
  check("车辆拒绝已记录并升级护士长", dec.ok === true && dec.message.includes("升级护士长"), JSON.stringify(dec));
  const hnPage = await get("/headnurse", cookies["headnurse"]);
  check("护士长升级看板展示延迟风险", hnPage.text.includes("黄疸转诊升级看板") && hnPage.text.includes("车辆拒绝派车导致转诊延迟"));
}

// 21. 护士长协调备用资源齐备 → 出发 → 到达外院交接
{
  const ok = await doAction(cookies["nurse1"], {
    action: "jaundice.coordinate", id: jcId,
    vehicleResult: "ok", vehicle: "护士长协调的备用商务车",
    escortResult: "ok", escort: "李婷（护理师）",
    targetHospital: "市儿童医院 新生儿科",
    handoverContent: "黄疸测量记录、喂养排泄记录、接种本、母婴手册、家长证件复印件、光疗转诊医嘱",
  });
  check("车辆/陪同/医院/交接齐备", ok.ok === true && ok.message.includes("齐备"), JSON.stringify(ok));
  const depart = await doAction(cookies["nurse1"], { action: "jaundice.transport", id: jcId, stage: "depart", at: "2026-10-01T15:10" });
  check("登记出发转诊", depart.ok === true, JSON.stringify(depart));
  const arrive = await doAction(cookies["nurse1"], { action: "jaundice.transport", id: jcId, stage: "arrive", at: "2026-10-01T16:00", note: "新生儿科接收，材料签字" });
  check("登记到达外院交接", arrive.ok === true, JSON.stringify(arrive));
}

// 22. 宝宝返中心：外院建议与原中心计划冲突 → 必须医生复核；复核后重建计划/取消过期提醒/同步排班 → 关闭闭环
{
  const ret = await doAction(cookies["nurse1"], {
    action: "jaundice.return", id: jcId, returnedAt: "2026-10-03T10:00",
    hospitalReceipt: "外院回执：高胆红素血症，蓝光24小时后TCB 10.8，带药茵栀黄；外院建议暂停母乳喂养72小时；一周后复诊。",
  });
  check("返中心回执识别喂养冲突并挂起常规护理", ret.ok === true && ret.conflict === true, JSON.stringify(ret));
  const nurseReview = await doAction(cookies["nurse1"], { action: "jaundice.doctorReview", id: jcId, reviewNote: "护理师不能复核", frequency: "每日1次" });
  check("护理师不能代替医生复核冲突", nurseReview.ok === false);
  const rv = await doAction(cookies["doctor"], {
    action: "jaundice.doctorReview", id: jcId,
    reviewNote: "混合喂养过渡72小时并加强复测，胆红素稳定下降后恢复母乳喂养。",
    frequency: "过渡72小时每12小时1次，之后每日1次", assigneeId: 3,
  });
  check("医生复核通过并重建观察计划", rv.ok === true && rv.message.includes("恢复常规护理"), JSON.stringify(rv));
  const stayPage = await get("/stays/2", cookies["admin"]);
  check("房间视图含复核重建计划与外院回执",
    stayPage.text.includes("黄疸观察复测（外院返中心·医生复核版）") && stayPage.text.includes("外院回执") && stayPage.text.includes("全程时间线"));
  const closeEarly = await doAction(cookies["nurse1"], { action: "jaundice.close", id: jcId });
  check("非护理主管不能关闭闭环", closeEarly.ok === false);
  const close = await doAction(cookies["headnurse"], { action: "jaundice.close", id: jcId });
  check("护理主管核对全程材料后关闭闭环", close.ok === true, JSON.stringify(close));
}

// 23. 护理主管页面可看到已完成闭环的时间线/交接材料
{
  const stayPage = await get("/stays/2", cookies["headnurse"]);
  check("闭环关闭后交接材料与时间线仍可追溯",
    stayPage.text.includes("市儿童医院 新生儿科") && stayPage.text.includes("中心护理交接材料"));
}

// 24. 另一条拒绝路径：家属暂拒转诊 → 同样自动升级护士长并留风险说明，继续留观
{
  const rep = await doAction(cookies["nurse1"], {
    action: "jaundice.report", stayId: 1, measuredAt: "2026-10-01T18:00",
    method: "TCB", value: 16.2, trend: "上升",
    feeding: "混合喂养", stool: "黄便3次", urine: "小便5次",
  });
  check("高值上报直接分级紧急转诊", rep.ok === true && rep.level === "urgent", JSON.stringify(rep));
  const doc = await doAction(cookies["doctor"], {
    action: "jaundice.doctorConfirm", id: rep.id, decision: "referral",
    advice: "TCB 16.2，建议立即转诊光疗。", referralReason: "TCB≥15",
  });
  check("医生确认转诊", doc.ok === true);
  const dec = await doAction(cookies["family1"], {
    action: "jaundice.familyDecide", id: rep.id, decision: "decline", note: "冒烟测试：家属想再观察一晚",
  });
  check("家属暂拒转诊自动升级护士长并留观", dec.ok === true && dec.message.includes("护士长"));
  const hnPage = await get("/headnurse", cookies["headnurse"]);
  check("护士长看板出现家属拒绝升级事件", hnPage.text.includes("家属拒绝转诊导致转诊延迟"));
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
