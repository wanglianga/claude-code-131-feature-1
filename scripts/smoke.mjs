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

// ============================================================
// 16. 宝宝黄疸升高：分级处置 + 转诊闭环（在 901 房 / family2 上进行，可重复运行）
const J = { cookie: null, caseId: null, case2: null };
{
  const fam = await login("family2", "family123");
  check("family2 登录", fam.ok === true);
  J.cookie = fam.cookie;
}

// 16.1 护理师测量 13.5 → 自动分级「加强复测」，建立待医生确认案例
{
  const r = await doAction(cookies["nurse1"], {
    action: "jaundice.measure", stayId: 2, measuredAt: "2026-09-25T10:00",
    method: "经皮胆红素（TCB）", level: 13.5, trend: "up",
    feeding: "母乳喂养，每2-3小时一次，吃奶有力", stool: "大便转黄每日3次，小便6次",
  });
  check("黄疸13.5自动分级为加强复测", r.ok === true && r.grade === "enhanced", JSON.stringify(r));
  J.caseId = r.id;
  const page = await get("/nurse", cookies["nurse1"]);
  check("护理工作台含黄疸分级处置入口与纪律提示",
    page.text.includes("宝宝黄疸测量与分级处置") && page.text.includes("不得自行向家属承诺转诊"));
}

// 16.2 医生确认前：家属端不展示处置建议、不能自行确认转诊；护理师不能代替医生确认
{
  const fp = await get("/family", J.cookie);
  check("医生确认前家属端仅提示等待确认", fp.text.includes("儿科医生确认处理建议后将在此向您同步"));
  const early = await doAction(J.cookie, { action: "jaundice.familyRespond", caseId: J.caseId, confirm: true });
  check("医生未建议转诊前家属确认被拒", early.ok === false);
  const nurseConfirm = await doAction(cookies["nurse1"], { action: "jaundice.doctorConfirm", caseId: J.caseId, decision: "referral", advice: "越权尝试" });
  check("护理师不能代替医生确认建议", nurseConfirm.ok === false);
}

// 16.3 医生先确认「加强复测」→ 自动下发复测提醒到护理师排班
{
  const r = await doAction(cookies["doctor"], {
    action: "jaundice.doctorConfirm", caseId: J.caseId,
    decision: "enhanced_retest", advice: "加强喂养，当日16:00复测，若继续升高立即复诊。",
    retestAt: "2026-09-25T16:00",
  });
  check("医生确认加强复测并下发复测提醒", r.ok === true, JSON.stringify(r));
  const fp = await get("/family", J.cookie);
  check("家属端仅展示医生确认后的建议", fp.text.includes("加强喂养，当日16:00复测"));
}

// 16.4 复测连续跨档升高（16.0 当班评估 → 19.0 紧急转诊），原确认失效退回医生再确认
{
  const r1 = await doAction(cookies["nurse1"], {
    action: "jaundice.measure", stayId: 2, measuredAt: "2026-09-25T16:00", level: 16.0, trend: "up",
    feeding: "吃奶稍差", stool: "小便偏少",
  });
  check("黄疸16.0自动分级为医生当班评估", r1.ok === true && r1.measuredGrade === "doctor_eval", JSON.stringify(r1));
  const r2 = await doAction(cookies["nurse1"], {
    action: "jaundice.measure", stayId: 2, measuredAt: "2026-09-25T18:00", level: 19.0, trend: "up",
    feeding: "吃奶差、嗜睡", stool: "大便颜色偏浅",
  });
  check("黄疸19.0自动分级为紧急转诊", r2.ok === true && r2.measuredGrade === "urgent_referral", JSON.stringify(r2));
}

// 16.5 医生确认转诊 → 家属确认前护士长不能协调
{
  const r = await doAction(cookies["doctor"], {
    action: "jaundice.doctorConfirm", caseId: J.caseId,
    decision: "referral", advice: "胆红素19mg/dL伴吃奶差，建议立即转市妇幼保健院新生儿科光疗。",
  });
  check("医生确认建议转诊", r.ok === true);
  const fp = await get("/family", J.cookie);
  check("家属端出现转诊确认入口与医生建议", fp.text.includes("我确认转诊") && fp.text.includes("市妇幼保健院新生儿科光疗"));
  const earlyCoord = await doAction(cookies["headnurse"], {
    action: "jaundice.coordinate", caseId: J.caseId, vehicleInfo: "粤B·12345", escortName: "王芳", targetHospital: "市妇幼",
  });
  check("家属确认前转诊协调被拒", earlyCoord.ok === false);
}

// 16.6 家属确认转诊
{
  const r = await doAction(J.cookie, { action: "jaundice.familyRespond", caseId: J.caseId, confirm: true, note: "同意转诊，请尽快安排" });
  check("家属确认转诊", r.ok === true);
}

// 16.7 护士长协调车辆/陪同/目标医院/交接
{
  const r = await doAction(cookies["headnurse"], {
    action: "jaundice.coordinate", caseId: J.caseId,
    vehicleInfo: "粤B·12345（合作救护车辆，张师傅）", escortName: "王芳（护理师）", escortId: 3,
    targetHospital: "市妇幼保健院新生儿科", handoff: "近24小时喂养6次、黄疸趋势单、体温单、备用奶粉与尿布、产妇联系方式",
  });
  check("护士长完成转诊四要素协调", r.ok === true);
}

// 16.8 车辆拒绝导致延迟 → 自动升级护士长并保留风险说明；重新协调后闭环
{
  const d = await doAction(cookies["headnurse"], {
    action: "jaundice.reportDelay", caseId: J.caseId, reasonType: "vehicle_declined",
    reason: "合作车辆临时故障，备用车需40分钟", riskNote: "胆红素19mg/dL且吃奶差，等待期间持续监测，每15分钟评估精神反应",
  });
  check("车辆拒绝转诊延迟自动升级护士长", d.ok === true);
  const hp = await get("/headnurse", cookies["headnurse"]);
  check("护士长工作台展示延迟升级与风险说明", hp.text.includes("转诊延迟·已升级") && hp.text.includes("每15分钟评估精神反应"));
  const c2 = await doAction(cookies["headnurse"], {
    action: "jaundice.coordinate", caseId: J.caseId,
    vehicleInfo: "粤B·99999（中心专车，李师傅）", escortName: "王芳（护理师）", escortId: 3,
    targetHospital: "市妇幼保健院新生儿科", handoff: "同前交接单，另附最近一次黄疸19.0记录",
  });
  check("重新协调转诊成功", c2.ok === true);
}

// 16.9 出发 → 到达
{
  const dep = await doAction(cookies["nurse1"], { action: "jaundice.depart", caseId: J.caseId });
  check("登记转诊出发", dep.ok === true);
  const arr = await doAction(cookies["nurse1"], { action: "jaundice.arrive", caseId: J.caseId, note: "与新生儿科值班护士完成床旁交接" });
  check("登记到达外院", arr.ok === true);
}

// 16.10 返中心登记：勾选冲突但不填冲突点 → 拒绝；填写完整 → 进入冲突待复核
{
  const bad = await doAction(cookies["headnurse"], {
    action: "jaundice.return", caseId: J.caseId,
    externalReceipt: "外院光疗24小时", externalAdvice: "暂停母乳48小时改配方奶", conflict: true,
  });
  check("标记计划冲突必须说明冲突点", bad.ok === false);
  const r = await doAction(cookies["headnurse"], {
    action: "jaundice.return", caseId: J.caseId,
    externalReceipt: "新生儿高胆红素血症，光疗24小时后胆红素降至11.2mg/dL",
    externalAdvice: "暂停母乳48小时、出院后隔日复测胆红素",
    conflict: true, conflictDetail: "外院建议暂停母乳，与中心现行母乳喂养支持计划冲突",
  });
  check("返中心登记回执并标记计划冲突", r.ok === true && r.message.includes("冲突"));
}

// 16.11 冲突未复核不能恢复；医生复核 → 取消过期提醒、重建计划、同步排班、恢复常规护理
{
  const blocked = await doAction(cookies["doctor"], {
    action: "jaundice.resume", caseId: J.caseId,
    newAdvice: "尝试恢复", frequency: "每日2次", assigneeId: 3, planTimes: "2026-09-26 09:00\n2026-09-26 20:00",
  });
  check("冲突未医生复核不能恢复常规护理", blocked.ok === false);
  const r = await doAction(cookies["doctor"], {
    action: "jaundice.resume", caseId: J.caseId,
    newAdvice: "尊重外院意见暂停母乳48小时，期间指导泵奶维持泌乳；隔日复测胆红素，若反弹再就诊。",
    frequency: "隔日1次复测", assigneeId: 3,
    planTimes: "2026-09-26 09:00\n2026-09-27 09:00", conflictResolved: true,
  });
  check("医生复核后重建计划并取消过期提醒",
    r.ok === true && /取消[1-9]\d*项过期提醒/.test(r.message) && r.message.includes("下发2项复测任务"), JSON.stringify(r));
  const fp = await get("/family", J.cookie);
  check("家属端展示新观察计划并告知恢复护理", fp.text.includes("已按新计划恢复护理") && fp.text.includes("暂停母乳48小时"));
  const sp = await get("/stays/2", cookies["admin"]);
  check("房间360视图含黄疸闭环、返中心观察计划与全程时间线",
    sp.text.includes("宝宝黄疸分级处置与转诊闭环") && sp.text.includes("黄疸返中心观察计划"));
}

// 16.12 家属拒绝转诊 → 自动升级护士长并保留风险说明；护理师不能自行协调
{
  const m = await doAction(cookies["nurse1"], {
    action: "jaundice.measure", stayId: 2, measuredAt: "2026-09-28T09:00", level: 18.6, trend: "up",
    feeding: "混合喂养", stool: "二便正常",
  });
  check("第二次升高建立新黄疸案例", m.ok === true);
  J.case2 = m.id;
  const dc = await doAction(cookies["doctor"], {
    action: "jaundice.doctorConfirm", caseId: J.case2,
    decision: "referral", advice: "胆红素再次升至18.6mg/dL，建议转外院评估光疗。",
  });
  check("医生再次建议转诊", dc.ok === true);
  const dec = await doAction(J.cookie, {
    action: "jaundice.familyRespond", caseId: J.case2, confirm: false,
    note: "我们想再观察一晚", riskNote: "家属希望再观察一晚；已当面告知胆红素持续升高存在胆红素脑病风险，建议立即转诊",
  });
  check("家属拒绝转诊自动升级护士长并留存风险说明", dec.ok === true);
  const hp = await get("/headnurse", cookies["headnurse"]);
  check("护士长可见家属拒绝的风险告知", hp.text.includes("胆红素脑病风险"));
  const nurseCoord = await doAction(cookies["nurse1"], {
    action: "jaundice.coordinate", caseId: J.case2, vehicleInfo: "x", escortName: "x", targetHospital: "x",
  });
  check("护理师不能自行启动转诊协调", nurseCoord.ok === false);
  // 护士长沟通后家属改主意、重新确认 → 延迟事项闭环
  const reconfirm = await doAction(J.cookie, { action: "jaundice.familyRespond", caseId: J.case2, confirm: true, note: "听从医嘱，同意转诊" });
  check("护士长介入后家属重新确认转诊", reconfirm.ok === true);
  const co = await doAction(cookies["headnurse"], {
    action: "jaundice.coordinate", caseId: J.case2,
    vehicleInfo: "粤B·88888（中心专车）", escortName: "李婷（护理师）", escortId: 4,
    targetHospital: "市妇幼保健院新生儿科", handoff: "黄疸记录与喂养情况交接单",
  });
  check("延迟后重新协调成功并闭环升级事项", co.ok === true);
  await doAction(cookies["nurse1"], { action: "jaundice.depart", caseId: J.case2 });
  await doAction(cookies["nurse1"], { action: "jaundice.arrive", caseId: J.case2 });
  const ret = await doAction(cookies["headnurse"], {
    action: "jaundice.return", caseId: J.case2,
    externalReceipt: "光疗12小时后胆红素降至10.5mg/dL", externalAdvice: "出院后每日复测胆红素×3天",
  });
  check("第二例返中心登记（无冲突）", ret.ok === true);
  const res = await doAction(cookies["doctor"], {
    action: "jaundice.resume", caseId: J.case2,
    newAdvice: "每日复测胆红素×3天，加强喂养，若回升及时就诊。", frequency: "每日1次", assigneeId: 3,
    planTimes: "2026-09-29 09:00\n2026-09-30 09:00",
  });
  check("第二例医生复核后恢复常规护理", res.ok === true && res.message.includes("恢复常规护理"), JSON.stringify(res));
}

// 16.13 黄疸回落至正常范围：不新建分级案例/异常工单（可重复运行）
{
  const r = await doAction(cookies["nurse1"], {
    action: "jaundice.measure", stayId: 2, measuredAt: "2026-10-01T09:00", level: 7.2, trend: "down",
    feeding: "吃奶恢复正常", stool: "二便正常",
  });
  check("黄疸7.2正常范围不建分级案例", r.ok === true && r.measuredGrade === "normal" && r.grade === "normal", JSON.stringify(r));
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
