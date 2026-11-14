/**
 * Google Apps Script: trả về lịch (hôm nay + ngày mai) và việc chưa xong trong Google Tasks dạng JSON.
 * Chạy dưới tài khoản Google của bạn — không cần Google Cloud Console.
 *
 * Cài đặt (xem README, mục 1):
 *  1. script.google.com → New project → dán toàn bộ file này.
 *  2. Đổi TOKEN bên dưới thành một chuỗi bí mật bất kỳ.
 *  3. Services (+) → thêm "Google Tasks API".
 *  4. Deploy → New deployment → Web app; Execute as: Me; Who has access: Anyone → Deploy, cho phép quyền.
 *  5. Copy "Web app URL" → GitHub secret DATA_URL = <URL>?token=<TOKEN>
 */
const TOKEN = 'DOI-THANH-CHUOI-BI-MAT';
const TZ = 'Asia/Ho_Chi_Minh';

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.code && p.state) return larkCallback_(p);              // Lark chuyển về sau khi anh bấm Đồng ý
  if (p.token !== TOKEN) {
    return ContentService.createTextOutput('{"error":"forbidden"}').setMimeType(ContentService.MimeType.JSON);
  }
  if (p.action === 'lark_login') return larkLogin_();         // mở link này để đăng nhập Lark 1 lần
  if (p.action === 'lark_status') return json_(larkStatus_());
  return json_(collect_());
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** Mac mini gửi mức dùng Claude lên đây (POST ?token=...), lưu lại để doGet trả kèm. */
function doPost(e) {
  if (!e || !e.parameter || e.parameter.token !== TOKEN) {
    return ContentService.createTextOutput('{"error":"forbidden"}').setMimeType(ContentService.MimeType.JSON);
  }
  const body = JSON.parse(e.postData.contents);
  // Cài đặt Lark (gửi 1 lần từ máy, để mã bí mật không nằm trong code)
  if (body && body.action === 'lark_setup') {
    const sp = PropertiesService.getScriptProperties();
    sp.setProperties({ lark_app_id: body.app_id, lark_app_secret: body.app_secret, lark_redirect: body.redirect_uri });
    return json_({ ok: true });
  }
  // Giữ mọi mục có % sử dụng (five_hour, seven_day, Fable, ...) + danh sách tên mục để dò lỗi
  const keep = { fetched_at: new Date().toISOString(), bucket_keys: Object.keys(body) };
  Object.keys(body).forEach(function (k) {
    const v = body[k];
    if (v && typeof v === 'object' && typeof v.utilization === 'number') {
      keep[k] = { utilization: v.utilization, resets_at: v.resets_at || null };
    }
  });
  // Bản thô (chỉ các mục khác null): Fable nằm trong danh sách "limits" ở đây
  const raw = {};
  Object.keys(body).forEach(function (k) { if (body[k] !== null) raw[k] = body[k]; });
  keep.raw = JSON.stringify(raw).slice(0, 6000);
  PropertiesService.getScriptProperties().setProperty('claude_usage', JSON.stringify(keep));
  return ContentService.createTextOutput('{"ok":true}').setMimeType(ContentService.MimeType.JSON);
}

function collect_() {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const start = new Date(today + 'T00:00:00+07:00');
  const end = new Date(start.getTime() + 2 * 86400000);

  const events = [];
  CalendarApp.getAllCalendars().forEach(function (cal) {
    if (cal.isHidden() || !cal.isSelected()) return;
    cal.getEvents(start, end).forEach(function (ev) {
      try {
        if (ev.getMyStatus() === CalendarApp.GuestStatus.NO) return;  // đã từ chối
      } catch (err) {}
      const o = { title: ev.getTitle() || '(Không tiêu đề)', location: ev.getLocation() || '', calendar: cal.getName() };
      if (ev.isAllDayEvent()) {
        o.allDay = true;
        o.startDate = Utilities.formatDate(ev.getAllDayStartDate(), TZ, 'yyyy-MM-dd');
        o.endDate = Utilities.formatDate(ev.getAllDayEndDate(), TZ, 'yyyy-MM-dd');
      } else {
        o.allDay = false;
        o.start = ev.getStartTime().toISOString();
        o.end = ev.getEndTime().toISOString();
      }
      events.push(o);
    });
  });

  const tasks = [];
  const lists = Tasks.Tasklists.list({ maxResults: 100 }).items || [];
  lists.forEach(function (tl) {
    let pageToken;
    do {
      const r = Tasks.Tasks.list(tl.id, { showCompleted: false, showHidden: false, maxResults: 100, pageToken: pageToken });
      (r.items || []).forEach(function (t) {
        if (t.title && t.title.trim()) {
          tasks.push({ title: t.title.trim(), due: t.due ? t.due.slice(0, 10) : null, list: tl.title, notes: t.notes || '' });
        }
      });
      pageToken = r.nextPageToken;
    } while (pageToken);
  });

  // ---- Lark: gộp lịch + việc từ Lark (nếu đã cài đặt), bỏ trùng với Google
  const lark = larkCollect_(start, end);
  const seenEv = {};
  events.forEach(function (ev) { seenEv[evKey_(ev)] = true; });
  lark.events.forEach(function (ev) { if (!seenEv[evKey_(ev)]) { seenEv[evKey_(ev)] = true; events.push(ev); } });
  const seenTask = {};
  tasks.forEach(function (t) { seenTask[norm_(t.title)] = true; });
  lark.tasks.forEach(function (t) { if (!seenTask[norm_(t.title)]) { seenTask[norm_(t.title)] = true; tasks.push(t); } });

  const claudeRaw = PropertiesService.getScriptProperties().getProperty('claude_usage');
  return { generated: new Date().toISOString(), events: events, tasks: tasks, lark: lark.status,
           claude: claudeRaw ? JSON.parse(claudeRaw) : null };
}

function norm_(s) { return String(s || '').trim().toLowerCase(); }
function evKey_(ev) { return norm_(ev.title) + '|' + (ev.allDay ? ev.startDate : String(ev.start).slice(0, 16)); }

/* ======================= LARK ======================= */
const LARK = 'https://open.larksuite.com';
const LARK_SCOPES = 'offline_access task:task:read task:tasklist:read calendar:calendar:read calendar:calendar.event:read';

function larkProps_() { return PropertiesService.getScriptProperties(); }

/** Trang đăng nhập Lark (mở bằng ?token=...&action=lark_login). */
function larkLogin_() {
  const sp = larkProps_();
  const appId = sp.getProperty('lark_app_id'), redirect = sp.getProperty('lark_redirect');
  if (!appId || !redirect) return HtmlService.createHtmlOutput('<p>Chưa cài đặt Lark (thiếu app_id / redirect).</p>');
  const state = Utilities.getUuid();
  sp.setProperty('lark_state', state + '|' + Date.now());
  const url = LARK + '/open-apis/authen/v1/authorize?client_id=' + encodeURIComponent(appId) +
    '&response_type=code&redirect_uri=' + encodeURIComponent(redirect) +
    '&scope=' + encodeURIComponent(LARK_SCOPES) + '&state=' + encodeURIComponent(state);
  return HtmlService.createHtmlOutput(
    '<div style="font:18px sans-serif;padding:40px">' +
    '<p>Kết nối Kindle Dashboard với Lark</p>' +
    '<p><a target="_top" style="font-size:22px" href="' + url + '">Bấm vào đây để đăng nhập Lark</a></p></div>');
}

/** Lark chuyển về đây kèm ?code=...&state=... → đổi lấy quyền truy cập, lưu lại. */
function larkCallback_(p) {
  const sp = larkProps_();
  const saved = (sp.getProperty('lark_state') || '').split('|');
  if (saved[0] !== p.state || Date.now() - Number(saved[1] || 0) > 15 * 60 * 1000) {
    return HtmlService.createHtmlOutput('<p style="font:18px sans-serif;padding:40px">Link đăng nhập đã hết hạn. Mở lại link đăng nhập rồi thử lại.</p>');
  }
  sp.deleteProperty('lark_state');
  const r = larkToken_({ grant_type: 'authorization_code', code: p.code, redirect_uri: sp.getProperty('lark_redirect') });
  const ok = !!r.refresh_token;
  return HtmlService.createHtmlOutput('<p style="font:20px sans-serif;padding:40px">' +
    (ok ? '✅ Đã kết nối Lark. Có thể đóng trang này.' : '❌ Kết nối Lark lỗi: ' + (r.error_description || r.msg || r.error || 'không nhận được refresh_token')) + '</p>');
}

/** Gọi API đổi mã / gia hạn quyền của Lark, lưu access + refresh token mới. */
function larkToken_(extra) {
  const sp = larkProps_();
  const payload = Object.assign({ client_id: sp.getProperty('lark_app_id'), client_secret: sp.getProperty('lark_app_secret') }, extra);
  const res = UrlFetchApp.fetch(LARK + '/open-apis/authen/v2/oauth/token', {
    method: 'post', contentType: 'application/json; charset=utf-8', payload: JSON.stringify(payload), muteHttpExceptions: true });
  const r = JSON.parse(res.getContentText() || '{}');
  if (r.access_token) {
    const now = Date.now();
    sp.setProperties({ lark_access: r.access_token, lark_access_exp: String(now + (r.expires_in || 7200) * 1000) });
    if (r.refresh_token) {
      sp.setProperties({ lark_refresh: r.refresh_token,
        lark_refresh_exp: String(now + (r.refresh_token_expires_in || 30 * 86400) * 1000) });
    }
  }
  return r;
}

/** Lấy quyền truy cập còn hạn (tự gia hạn; khoá để 2 lần gọi cùng lúc không gia hạn chồng nhau). */
function larkAccess_() {
  const sp = larkProps_();
  if (Number(sp.getProperty('lark_access_exp') || 0) - Date.now() > 5 * 60 * 1000) return sp.getProperty('lark_access');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (Number(sp.getProperty('lark_access_exp') || 0) - Date.now() > 5 * 60 * 1000) return sp.getProperty('lark_access');
    const refresh = sp.getProperty('lark_refresh');
    if (!refresh) throw new Error('chưa đăng nhập Lark');
    const r = larkToken_({ grant_type: 'refresh_token', refresh_token: refresh });
    if (!r.access_token) throw new Error('gia hạn Lark lỗi: ' + (r.error_description || r.msg || r.error || r.code));
    return r.access_token;
  } finally {
    lock.releaseLock();
  }
}

function larkGet_(path, method) {
  const res = UrlFetchApp.fetch(LARK + path, {
    method: method || 'get', headers: { Authorization: 'Bearer ' + larkAccess_() }, muteHttpExceptions: true,
    contentType: 'application/json; charset=utf-8', payload: method === 'post' ? '{}' : undefined });
  const r = JSON.parse(res.getContentText() || '{}');
  if (r.code !== 0) throw new Error(path.split('?')[0] + ' → ' + r.code + ' ' + r.msg);
  return r.data || {};
}

function larkStatus_() {
  const sp = larkProps_();
  return { configured: !!sp.getProperty('lark_app_id'), logged_in: !!sp.getProperty('lark_refresh'),
           refresh_expires: sp.getProperty('lark_refresh_exp') ? new Date(Number(sp.getProperty('lark_refresh_exp'))).toISOString() : null };
}

/** Lịch (hôm nay + ngày mai) và việc chưa xong của anh trên Lark. Lỗi thì báo thành 1 dòng việc trên Kindle. */
function larkCollect_(start, end) {
  const out = { events: [], tasks: [], status: larkStatus_() };
  if (!out.status.configured) return out;
  try {
    // ---- Lịch: lịch chính, bung cả sự kiện lặp lại trong khoảng thời gian
    const sp = larkProps_();
    let calId = sp.getProperty('lark_cal_id');
    if (!calId) {
      calId = larkGet_('/open-apis/calendar/v4/calendars/primary', 'post').calendars[0].calendar.calendar_id;
      sp.setProperty('lark_cal_id', calId);
    }
    const ev = larkGet_('/open-apis/calendar/v4/calendars/' + encodeURIComponent(calId) + '/events/instance_view?start_time=' +
      Math.floor(start.getTime() / 1000) + '&end_time=' + Math.floor(end.getTime() / 1000));
    (ev.items || []).forEach(function (it) {
      if (it.status === 'cancelled') return;
      const o = { title: it.summary || '(Không tiêu đề)', location: (it.location && it.location.name) || '', calendar: 'Lark' };
      if (it.start_time && it.start_time.date) {
        o.allDay = true; o.startDate = it.start_time.date; o.endDate = (it.end_time && it.end_time.date) || it.start_time.date;
      } else {
        o.allDay = false;
        o.start = new Date(Number(it.start_time.timestamp) * 1000).toISOString();
        o.end = new Date(Number(it.end_time.timestamp) * 1000).toISOString();
      }
      out.events.push(o);
    });
    // ---- Việc: những việc anh phụ trách, chưa xong
    let pageToken = '';
    do {
      const t = larkGet_('/open-apis/task/v2/tasks?type=my_tasks&completed=false&page_size=100' +
        (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : ''));
      (t.items || []).forEach(function (it) {
        if (!it.summary || it.completed_at && it.completed_at !== '0') return;
        out.tasks.push({ title: it.summary.trim(), list: 'Lark', notes: it.description || '',
          due: it.due && it.due.timestamp ? Utilities.formatDate(new Date(Number(it.due.timestamp)), TZ, 'yyyy-MM-dd') : null });
      });
      pageToken = t.has_more ? t.page_token : '';
    } while (pageToken);
  } catch (err) {
    out.status.error = String(err.message || err).slice(0, 200);
    out.tasks.push({ title: 'Lark mất kết nối - nhắn Claude đăng nhập lại', due: null, list: 'Lark', notes: out.status.error });
  }
  return out;
}

/** Bấm Run hàm này để thử phần Lark (xem kết quả ở Execution log). */
function testLark() {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const start = new Date(today + 'T00:00:00+07:00');
  Logger.log(JSON.stringify(larkCollect_(start, new Date(start.getTime() + 2 * 86400000)), null, 2));
}

/** Bấm Run hàm này trong trình soạn thảo để kiểm tra (xem kết quả ở Execution log). */
function testCollect() {
  Logger.log(JSON.stringify(collect_(), null, 2));
}
