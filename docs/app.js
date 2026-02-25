/* Production-grade Approved UI (Modern Cards)
 * - Auto refresh 2s using version check
 * - Pending-first display
 * - Approve with passcode (role handled by backend)
 * - PDF no passcode
 * - Latest first
 */

const CFG = window.APP_CONFIG || {};
const API_BASE = (CFG.API_BASE_URL || "").trim();

const state = {
  rows: [],
  limit: Number(CFG.DEFAULT_LIMIT || 5),
  offset: 0,
  mode: "pending",  // pending|all
  query: "",
  lastVersion: 0,
  timer: null,

  alarmMp3Url: "",
  lastPending: 0,
  alarmTimer: null,

  AC: null,
  masterGain: null
};

/* ---------------- Chrome / Desktop Notification (Card pop-up) ----------------
 * Works when tab is in background (page still open), after user grants permission.
 * If you need notifications even when tab is closed, implement PWA Service Worker + Push (not included).
 */
const notifyState = {
  lastNotifyAt: 0,
  lastNotifiedPending: 0,
  minIntervalMs: 8000 // avoid spam
};

async function ensureNotificationPermission(){
  if(!("Notification" in window)) return false;
  if(Notification.permission === "granted") return true;
  if(Notification.permission === "denied") return false;
  try{
    const p = await Notification.requestPermission();
    return p === "granted";
  }catch(_){ return false; }
}

function showPendingNotification(pendingCount){
  if(!("Notification" in window)) return;
  if(Notification.permission !== "granted") return;

  const now = Date.now();
  if(now - notifyState.lastNotifyAt < notifyState.minIntervalMs) return;
  if(pendingCount <= 0) return;
  if(pendingCount <= notifyState.lastNotifiedPending) return;

  // Notify when tab not visible / not focused
  if(document.visibilityState === "visible" && document.hasFocus()) return;

  notifyState.lastNotifyAt = now;
  notifyState.lastNotifiedPending = pendingCount;

  try{
    const title = "🍽️ มีรายการอาหาร Pending";
    const body = `Pending: ${pendingCount} รายการ • กดเพื่อกลับไปหน้า Approved`;
    const n = new Notification(title, {
      body,
      icon: "./favicon.svg",
      badge: "./favicon.svg",
      tag: "bhh-meal-pending",
      renotify: true
    });
    n.onclick = () => { try{ window.focus(); }catch(_){} n.close(); };
    setTimeout(()=>{ try{ n.close(); }catch(_){} }, 10000);
  }catch(_){}
}


function el(id){ return document.getElementById(id); }

function apiUrl(action, params = {}){
  const u = new URL(API_BASE);
  u.searchParams.set("action", action);
  Object.entries(params).forEach(([k,v])=>{
    if(v===undefined || v===null || v==="") return;
    u.searchParams.set(k, String(v));
  });
  return u.toString();
}
async function apiGet(action, params){
  const res = await fetch(apiUrl(action, params));
  const j = await res.json();
  if(!j.ok) throw new Error((j.error && j.error.message) || "API error");
  return j.data;
}
async function apiPost(action, body){
  const res = await fetch(apiUrl(action), {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(body || {})
  });
  const j = await res.json();
  if(!j.ok) throw new Error((j.error && j.error.message) || "API error");
  return j;
}

function escapeHtml(s){
  return String(s??"").replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[m]));
}

// Data headers indices (ตาม sheet ของคุณ)
const IDX = {
  id:0, status:1, date:2, hn:3, name:4, dob:5, allergy:6, comorb:7,
  requester:8, dept:9,
  tuna:10, fish:11, chicken:12, shrimp:13, custom:14,
  note:23
};

function statusKind(status){
  const s = String(status||"");
  if(!s || s.includes("Pending")) return "pending";
  if(s.includes("Food House รับ Order")) return "step1";
  if(s.includes("Food House เตรียมอาหารเสร็จแล้ว")) return "step2";
  if(s.includes("หน่วยงานรับอาหารแล้ว")) return "done";
  return "pending";
}

function statusPill(kind){
  if(kind==="pending") return `<span class="pill pill-warn">🔔 Pending</span>`;
  if(kind==="step1") return `<span class="pill pill-info">🧑‍🍳 รับออเดอร์แล้ว</span>`;
  if(kind==="step2") return `<span class="pill pill-ok">🍲 เตรียมเสร็จแล้ว</span>`;
  return `<span class="pill pill-done">✅ เสร็จสิ้น</span>`;
}

function itemSummary(r){
  const custom = String(r[IDX.custom]||"").trim();
  const parts = [];

  const n = (x)=> Number(String(x||"").replace(/,/g,"")) || 0;

  const t = n(r[IDX.tuna]); if(t>0) parts.push(`แซนวิชทูน่า×${t}`);
  const f = n(r[IDX.fish]); if(f>0) parts.push(`ข้าวต้มปลา×${f}`);
  const c = n(r[IDX.chicken]); if(c>0) parts.push(`ข้าวต้มไก่×${c}`);
  const s = n(r[IDX.shrimp]); if(s>0) parts.push(`ข้าวต้มกุ้ง×${s}`);

  if(custom){
    const asNum = Number(String(custom).replace(/,/g,""));
    if(Number.isFinite(asNum) && asNum>0) parts.push(`Custom×${asNum}`);
    else parts.push(`Custom: ${custom}`);
  }
  return parts.length ? parts.join(", ") : "—";
}

function approveButton(kind, id){
  if(kind==="pending") return `<button class="btn btn-warning btn-sm" data-act="step0" data-id="${id}">รับออเดอร์</button>`;
  if(kind==="step1") return `<button class="btn btn-primary btn-sm" data-act="step1" data-id="${id}">เตรียมเสร็จ</button>`;
  if(kind==="step2") return `<button class="btn btn-success btn-sm" data-act="step2" data-id="${id}">หน่วยงานรับแล้ว</button>`;
  return `<button class="btn btn-outline-success btn-sm" disabled>เสร็จสิ้น</button>`;
}

function renderCard(r){
  const id = r[IDX.id];
  const status = r[IDX.status];
  const kind = statusKind(status);

  const cls = `order-card ${kind}`;

  const note = String(r[IDX.note]||"").trim();
  const allergy = String(r[IDX.allergy]||"").trim();
  const comorb = String(r[IDX.comorb]||"").trim();

  return `
    <section class="${cls}" data-rowid="${id}">
      <div class="order-top">
        <div class="flex-grow-1">
          <div class="d-flex flex-wrap gap-2 align-items-center">
            ${statusPill(kind)}
            <span class="pill pill-muted">ID: ${escapeHtml(id)}</span>
            <span class="pill pill-muted">แผนก: ${escapeHtml(r[IDX.dept]||"-")}</span>
            <span class="pill pill-muted">HN: ${escapeHtml(r[IDX.hn]||"-")}</span>
          </div>

          <div class="mt-2 fw-semibold fs-5">${escapeHtml(r[IDX.name]||"-")}</div>

          <div class="meta">
            <div>🗓️ <b>${escapeHtml(r[IDX.date]||"-")}</b></div>
            <div>🎂 <b>${escapeHtml(r[IDX.dob]||"-")}</b></div>
            <div>👤 ผู้สั่ง: <b>${escapeHtml(r[IDX.requester]||"-")}</b></div>
          </div>

          <div class="items">
            <div class="summary">
              <span class="pill pill-muted">🍽️ รายการ</span>
              <span class="fw-semibold">${escapeHtml(itemSummary(r))}</span>
            </div>

            <div class="small-muted mt-1">
              แพ้อาหาร: ${escapeHtml(allergy||"-")} • โรคประจำตัว: ${escapeHtml(comorb||"-")}
            </div>

            ${note ? `<div class="small mt-1"><b>หมายเหตุ:</b> ${escapeHtml(note)}</div>` : ``}

            <div class="status-text">${escapeHtml(status||"")}</div>
          </div>
        </div>

        <div class="btn-col">
          ${approveButton(kind, id)}
          <button class="btn btn-outline-secondary btn-sm" data-act="slip" data-id="${id}">Download PDF</button>
        </div>
      </div>
    </section>
  `;
}

function filteredRows(){
  const q = (state.query||"").trim().toLowerCase();
  if(!q) return state.rows;
  return state.rows.filter(r=>{
    const s = [r[IDX.hn], r[IDX.name], r[IDX.dept], r[IDX.requester]].join(" ").toLowerCase();
    return s.includes(q);
  });
}

function render(){
  const list = el("list");
  const rows = filteredRows();
  const slice = rows.slice(0, state.offset + state.limit);

  list.innerHTML = slice.length
    ? slice.map(renderCard).join("")
    : `<div class="cardx">ไม่พบข้อมูล</div>`;

  el("loadMoreBtn").disabled = slice.length >= rows.length;
}

function nowText(){
  return new Date().toLocaleString("th-TH",{hour12:false});
}

async function loadRows(reset=false){
  if(reset){
    state.offset = 0;
    state.rows = [];
  }
  // Fetch only what we need for UI (fast)
  const need = Math.min(200, Math.max(10, state.limit + state.offset + 5));
  const data = await apiGet("orders", { mode: state.mode, limit: need });
  state.rows = Array.isArray(data.rows) ? data.rows : [];

  // Latest first (higher ID = newer)
  state.rows.sort((a,b)=> (Number(b[IDX.id])||0) - (Number(a[IDX.id])||0));

  render();
  el("lastSync").textContent = `Sync: ${nowText()}`;
}

async function loadPendingCount(){
  try{
    const d = await apiGet("pendingCount");
    const n = Number(d.pendingCount||0);
    el("pendingBadge").textContent = `🔔 Pending: ${n}`;

    if(n > state.lastPending){
      await playOnce();
      showPendingNotification(n);
    }
    state.lastPending = n;
    scheduleAlarm();
  }catch(e){
    const n = (state.rows||[]).filter(r => statusKind(r[IDX.status])!=="done").length;
    el("pendingBadge").textContent = `🔔 Pending: ${n}`;
  }
}

/* ---------------- Sound (built-in + optional mp3) ---------------- */

function audioEl(){ return el("alarmAudio"); }

function ensureAC(){
  if(!state.AC){
    state.AC = new (window.AudioContext || window.webkitAudioContext)();
    state.masterGain = state.AC.createGain();
    state.masterGain.connect(state.AC.destination);
  }
}

function tone(freq,dur,type="sine",start=0,peak=1.0){
  const AC = state.AC;
  const osc = AC.createOscillator();
  const g = AC.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(g);
  g.connect(state.masterGain);

  const t0 = AC.currentTime + start;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  osc.start(t0);
  osc.stop(t0 + dur);
}

function playBuiltInPattern(name){
  ensureAC();
  if(state.AC.state==="suspended") state.AC.resume();

  switch(name){
    case "bell":
      tone(587,0.50,"triangle",0,0.85);
      tone(880,0.30,"triangle",0.18,0.7);
      break;
    case "chime":
      tone(880,0.30,"sine",0,0.9);
      tone(660,0.25,"sine",0.28,0.8);
      break;
    case "alert":
      for(let i=0;i<4;i++) tone(i%2?1200:900,0.12,"square",i*0.16,0.9);
      break;
    case "ding":
      tone(1568,0.18,"sine",0,0.95);
      break;
    default:
      tone(1000,0.12,"square",0,0.8);
      tone(1200,0.10,"square",0.16,0.8);
  }
}

function getSoundEls(){
  return {
    sel: el("soundSelect"),
    vol: el("volumeSlider"),
    enabled: el("soundEnabled"),
    volLabel: el("volumeValue"),
    toggle: el("toggleSoundPanel"),
    panel: el("soundControl"),
    panelBody: el("soundPanelContent")
  };
}

function initSoundUI(){
  const {sel,vol,enabled,volLabel,toggle,panel,panelBody} = getSoundEls();

  sel.value = localStorage.getItem("alertSound") || sel.value;
  vol.value = localStorage.getItem("alertVol") || vol.value;
  enabled.checked = (localStorage.getItem("alertEnabled") !== "0");
  volLabel.textContent = vol.value;

  function applyVol(){
    const v = Number(vol.value)/100;
    if(state.masterGain) state.masterGain.gain.value = v;
    audioEl().volume = v;
  }
  applyVol();

  sel.addEventListener("change", ()=>{
    localStorage.setItem("alertSound", sel.value);
    if(sel.value==="notification" && state.alarmMp3Url) audioEl().src = state.alarmMp3Url;
  });

  vol.addEventListener("input", ()=>{
    localStorage.setItem("alertVol", vol.value);
    volLabel.textContent = vol.value;
    applyVol();
  });

  enabled.addEventListener("change", ()=>{
    localStorage.setItem("alertEnabled", enabled.checked ? "1" : "0");
  });

  toggle.addEventListener("click", ()=>{
    const collapsed = panel.classList.toggle("collapsed");
    panelBody.style.display = collapsed ? "none" : "";
    toggle.textContent = collapsed ? "+" : "−";
  });

  // unlock audio on first click (browser restriction)
  window.addEventListener("click", function onFirst(){
    const a = audioEl();
    a.muted = true;
    a.play().then(()=>{ a.pause(); a.currentTime=0; a.muted=false; }).catch(()=>{});
    window.removeEventListener("click", onFirst);
  }, { once:true });
}

async function playOnce(){
  const {sel,enabled} = getSoundEls();
  if(!enabled.checked) return false;

  if(sel.value==="notification" && state.alarmMp3Url){
    try{
      const a = audioEl();
      if(a.src !== state.alarmMp3Url) a.src = state.alarmMp3Url;
      a.currentTime = 0;
      await a.play();
      setTimeout(()=>{ try{ a.pause(); }catch(_){} }, 2500);
      return true;
    }catch(_){
      playBuiltInPattern("notification");
      return false;
    }
  }
  playBuiltInPattern(sel.value);
  return true;
}

function scheduleAlarm(){
  if(state.alarmTimer) clearInterval(state.alarmTimer);
  if(state.lastPending<=0) return;
  state.alarmTimer = setInterval(()=>{ playOnce(); }, 15000);
}

/* ---------------- Actions ---------------- */

async function approveStep(id, step, label){
  const { value: passcode } = await Swal.fire({
    position: "top",
    title: "กรอกรหัสสำหรับการอนุมัติ",
    input: "password",
    inputLabel: label,
    inputPlaceholder: "กรุณากรอกรหัสผ่าน",
    allowOutsideClick: false,
    confirmButtonColor: "#0033A0",
    confirmButtonText: "ตกลง"
  });
  if(!passcode) return;

  try{
    Swal.fire({title:"กำลังบันทึก...", allowOutsideClick:false, didOpen:()=>Swal.showLoading()});
    const res = await apiPost("updateStatus", { id, step, passcode });
    Swal.close();

    // quick patch locally
    const idx = state.rows.findIndex(r => Number(r[IDX.id]) === Number(id));
    if(idx>=0) state.rows[idx][IDX.status] = res.status || res.data?.status || state.rows[idx][IDX.status];

    render();
    await loadPendingCount();

    Swal.fire({icon:"success", title:"อัปเดตเรียบร้อย", timer:900, showConfirmButton:false});
  }catch(e){
    Swal.close();
    Swal.fire({icon:"error", title:"ผิดพลาด", text:e.message || "โปรดลองใหม่"});
  }
}

async function downloadSlip(id){
  try{
    Swal.fire({title:"กำลังสร้าง PDF...", allowOutsideClick:false, didOpen:()=>Swal.showLoading()});
    const res = await apiPost("slip", { id }); // NO passcode
    Swal.close();

    const obj = res.data;
    const a = document.createElement("a");
    a.href = "data:application/pdf;base64," + obj.b64;
    a.download = obj.filename || `MealSlip_${id}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }catch(e){
    Swal.close();
    Swal.fire({icon:"error", title:"ล้มเหลว", text:e.message || "โปรดลองใหม่"});
  }
}

/* ---------------- Boot + Polling ---------------- */

function applyBrand(){
  el("brandTitle").textContent = CFG.BRAND_TITLE || "Meal Ordering • Approved";
  el("brandLogo").src = CFG.BRAND_LOGO_URL || "";
  el("envLabel").textContent = CFG.ENV_LABEL || "";
}

function bindEvents(){
  el("limitSelect").addEventListener("change", (ev)=>{
    state.limit = Number(ev.target.value || 5);
    render();
  });

  el("searchBox").addEventListener("input", (ev)=>{
    state.query = ev.target.value || "";
    render();
  });

  el("loadMoreBtn").addEventListener("click", async ()=>{
    state.offset += state.limit;
    // If we don't have enough rows for the next page, fetch a bit more (still lightweight)
    if(state.rows.length < state.offset + state.limit){
      await loadRows(false);
    } else {
      render();
    }
  });

  el("refreshBtn").addEventListener("click", async ()=>{
    await Promise.all([loadRows(true), loadPendingCount()]);
  });

  el("pendingOnly").addEventListener("change", async (ev)=>{
    state.mode = ev.target.checked ? "pending" : "all";
    await loadRows(true);
  });

  el("autoRefresh").addEventListener("change", (ev)=>{
    if(ev.target.checked) startPolling();
    else stopPolling();
  });

  el("list").addEventListener("click", (ev)=>{
    const btn = ev.target.closest("button[data-act]");
    if(!btn) return;
    const act = btn.getAttribute("data-act");
    const id = Number(btn.getAttribute("data-id"));

    if(act==="slip") return downloadSlip(id);
    if(act==="step0") return approveStep(id,0,"สำหรับ Food House เมื่อรับ Order อาหารแล้ว");
    if(act==="step1") return approveStep(id,1,"สำหรับ Food House เมื่อเตรียมอาหารเสร็จแล้ว");
    if(act==="step2") return approveStep(id,2,"สำหรับ Department");
  });

// Ask notification permission on first user gesture (browser requirement)
document.addEventListener("click", async function _askNotifOnce(){
  document.removeEventListener("click", _askNotifOnce);
  await ensureNotificationPermission();
}, { once:true });

}

async function fetchAlarmUrl(){
  try{
    const d = await apiGet("alarmUrl");
    state.alarmMp3Url = d.alarmMp3Url || "";
    const {sel} = getSoundEls();
    if(sel.value==="notification" && state.alarmMp3Url){
      audioEl().src = state.alarmMp3Url;
    }
  }catch(_){
    state.alarmMp3Url = "";
  }
}

async function pollTick(){
  // Reduce load: only fetch orders when version changes
  try{
    const v = Number((await apiGet("version")).version || 0);
    if(v !== state.lastVersion){
      state.lastVersion = v;
      await loadRows(true);
    }
    await loadPendingCount();
  }catch(_){
    // ignore
  }
}

function startPolling(){
  stopPolling();
  const ms = Number(CFG.POLL_MS || 2000);
  state.timer = setInterval(pollTick, ms);
}
function stopPolling(){
  if(state.timer) clearInterval(state.timer);
  state.timer = null;
}

async function boot(){
  if(!API_BASE){
    document.body.innerHTML = `<div class="p-4">Missing API_BASE_URL in config.js</div>`;
    return;
  }

  applyBrand();
  initSoundUI();

  await fetchAlarmUrl();
  await loadRows(true);
  await loadPendingCount();

  // init version
  try{ state.lastVersion = Number((await apiGet("version")).version || 0); }catch(_){}

  if(el("autoRefresh").checked) startPolling();
}

document.addEventListener("DOMContentLoaded", ()=>{
  bindEvents();
  boot();
});
