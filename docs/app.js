/* Approved Dashboard – GitHub Pages Frontend (static)
 * Features (per requirement / original base code):
 * - Food House/Department update status (3 steps) with passcode + role gate
 * - PDF slip download (NO passcode)
 * - Sound alert for pending orders
 * - Auto refresh using version polling
 *
 * Backend: Cloudflare Worker → GAS Web App
 */
const CFG = window.APP_CONFIG || {};
const API_BASE = (CFG.API_BASE_URL || "").trim();

function assertConfig(){
  if (!API_BASE){
    document.body.innerHTML = `
      <div style="max-width:720px;margin:40px auto;font-family:system-ui;padding:16px">
        <h2>ยังไม่ได้ตั้งค่า API_BASE_URL</h2>
        <p>กรุณาแก้ไฟล์ <code>docs/config.js</code> แล้วใส่ Worker URL</p>
      </div>`;
    throw new Error("Missing API_BASE_URL");
  }
}
function apiUrl(action){
  const u = new URL(API_BASE);
  u.searchParams.set("action", action);
  return u.toString();
}
async function apiGet(action){
  const res = await fetch(apiUrl(action), { method:"GET" });
  const j = await res.json();
  if (!j.ok) throw new Error((j.error && j.error.message) || "API error");
  return j.data;
}
async function apiPost(action, body){
  const res = await fetch(apiUrl(action), {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(body || {})
  });
  const j = await res.json();
  if (!j.ok) throw new Error((j.error && j.error.message) || "API error");
  return j;
}

let datatable=null;
let lastVersion=0;
let lastPending=0;
let alarmTimer=null;
let alarmMp3Url="";

// ----- Pending indicator -----
function showIndicator(count){
  document.getElementById("pendingCount").textContent = String(count);
  const el = document.getElementById("pendingIndicator");
  if (count>0) el.classList.remove("d-none"); else el.classList.add("d-none");
}

// ----- sound / notifications -----
let AC=null, masterGain=null;
function audioEl(){ return document.getElementById("alarmAudio"); }
function ensureAC(){
  if(!AC){
    AC = new (window.AudioContext||window.webkitAudioContext)();
    masterGain = AC.createGain();
    masterGain.connect(AC.destination);
  }
}
function tone(freq,dur,type="sine",start=0,peak=1.0){
  const osc=AC.createOscillator(), g=AC.createGain();
  osc.type=type; osc.frequency.value=freq; osc.connect(g); g.connect(masterGain);
  const t0=AC.currentTime+start;
  g.gain.setValueAtTime(0.0001,t0);
  g.gain.linearRampToValueAtTime(peak,t0+0.01);
  g.gain.exponentialRampToValueAtTime(0.0001,t0+dur);
  osc.start(t0); osc.stop(t0+dur);
}
function playBuiltInPattern(name){
  ensureAC();
  if(AC.state==="suspended") AC.resume();
  switch(name){
    case "bell": tone(587,0.50,"triangle",0,0.85); tone(880,0.30,"triangle",0.18,0.7); break;
    case "chime": tone(880,0.30,"sine",0,0.9); tone(660,0.25,"sine",0.28,0.8); break;
    case "alert": for(let i=0;i<4;i++) tone(i%2?1200:900,0.12,"square",i*0.16,0.9); break;
    case "ding": tone(1568,0.18,"sine",0,0.95); break;
    default: tone(1000,0.12,"square",0,0.8); tone(1200,0.10,"square",0.16,0.8);
  }
}
function notifyOS(count){
  if(typeof Notification==="undefined") return;
  if(Notification.permission!=="granted") return;
  new Notification("🍽️ มีออเดอร์ใหม่",{ body:`รอรับออเดอร์ ${count} รายการ`, requireInteraction:true });
}
function els(){
  return {
    sel: document.getElementById("soundSelect"),
    vol: document.getElementById("volumeSlider"),
    enabled: document.getElementById("soundEnabled"),
    volLabel: document.getElementById("volumeValue"),
    toggle: document.getElementById("toggleSoundPanel"),
    panel: document.getElementById("soundControl"),
    panelBody: document.getElementById("soundPanelContent"),
  };
}
function initSoundUI(){
  const {sel,vol,enabled,volLabel,toggle,panel,panelBody}=els();
  sel.value = localStorage.getItem("alertSound") || sel.value;
  vol.value = localStorage.getItem("alertVol") || vol.value;
  volLabel.textContent = vol.value;
  enabled.checked = (localStorage.getItem("alertEnabled") !== "0");

  function applyVol(){
    const v = Number(vol.value)/100;
    if(masterGain) masterGain.gain.value=v;
    const a=audioEl(); a.volume=v;
  }
  applyVol();

  sel.addEventListener("change", ()=>{
    localStorage.setItem("alertSound", sel.value);
    if(sel.value==="notification" && alarmMp3Url) audioEl().src=alarmMp3Url;
  });
  vol.addEventListener("input", ()=>{
    localStorage.setItem("alertVol", vol.value);
    volLabel.textContent = vol.value;
    applyVol();
  });
  enabled.addEventListener("change", ()=> localStorage.setItem("alertEnabled", enabled.checked?"1":"0"));
  toggle.addEventListener("click", ()=>{
    const collapsed = panel.classList.toggle("collapsed");
    panelBody.style.display = collapsed ? "none" : "";
    toggle.textContent = collapsed ? "+" : "−";
  });

  // Arm audio/notification permission on first click
  window.addEventListener("click", function onFirst(){
    const a=audioEl();
    a.muted=true;
    a.play().then(()=>{ a.pause(); a.currentTime=0; a.muted=false; }).catch(()=>{});
    if(typeof Notification!=="undefined" && Notification.permission==="default") Notification.requestPermission();
    window.removeEventListener("click", onFirst);
  }, {once:true});
}
async function playOnce(){
  const {sel,enabled}=els();
  if(!enabled.checked) return false;
  if(sel.value==="notification" && alarmMp3Url){
    try{
      const a=audioEl();
      if(a.src!==alarmMp3Url) a.src=alarmMp3Url;
      a.currentTime=0;
      await a.play();
      setTimeout(()=>{ try{ a.pause(); }catch(e){} }, 2500);
      return true;
    }catch(e){
      playBuiltInPattern("notification");
      return false;
    }
  }
  playBuiltInPattern(sel.value);
  return true;
}
function scheduleAlarm(){
  if(alarmTimer) clearInterval(alarmTimer);
  if(lastPending<=0) return;
  alarmTimer=setInterval(async ()=>{
    const ok=await playOnce();
    if(!ok && document.hidden) notifyOS(lastPending);
  }, 15000);
}

// ----- table + actions -----
function isPending(st){
  const s=String(st||"");
  const done = s.includes("Food House รับ Order") || s.includes("Food House เตรียมอาหารเสร็จแล้ว") || s.includes("หน่วยงานรับอาหารแล้ว");
  return (!s || !done || s.includes("Pending"));
}

function orderSummary(r){
  const items = [
    ["ทูน่า", Number(r[10]||0)],
    ["ปลา", Number(r[11]||0)],
    ["ไก่", Number(r[12]||0)],
    ["กุ้ง", Number(r[13]||0)],
    ["Custom", Number(r[14]||0)],
  ].filter(x=>x[1]>0).map(x=>`${x[0]}×${x[1]}`);
  return items.length ? items.join(", ") : "—";
}

function actionCell(status){
  const slipBtn = `<div class="mt-2"><button class='btn btn-outline-secondary btn-sm w-100' data-action="slip"><i class="fas fa-file-pdf"></i> Download PDF</button></div>`;
  const s=String(status||"");
  if(isPending(s)){
    return `<div class="small text-warning mb-1"><strong>🔔 รอ Food House รับ Order</strong></div>
      <button class='btn btn-warning btn-sm w-100' data-action="step0"><i class="fas fa-check"></i> รับออเดอร์</button>${slipBtn}`;
  }
  if(s.includes("Food House รับ Order")){
    return `<div class="small text-info mb-1"><i class="fas fa-clock"></i> กำลังเตรียมอาหาร</div>
      <button class='btn btn-primary btn-sm w-100' data-action="step1"><i class="fas fa-utensils"></i> เตรียมเสร็จ</button>${slipBtn}`;
  }
  if(s.includes("Food House เตรียมอาหารเสร็จแล้ว")){
    return `<div class="small text-success mb-1"><i class="fas fa-truck"></i> รอหน่วยงานรับ</div>
      <button class='btn btn-success btn-sm w-100' data-action="step2"><i class="fas fa-check-circle"></i> หน่วยงานรับแล้ว</button>${slipBtn}`;
  }
  return `<div class="small text-success"><i class="fas fa-check-double"></i> เสร็จสิ้น</div>${slipBtn}`;
}

function buildTable(rows){
  // Visible columns (includes new summary column)
  const mainHeaders=[
    "Action","ID","สถานะ","วันที่","HN","ชื่อผู้ป่วย","วันเกิด","แพ้อาหาร","โรคประจำตัว","ผู้ส่ง","แผนก",
    "รายการที่สั่ง",
    "แซนวิชทูน่า","ข้าวต้มปลา","ข้าวต้มไก่","ข้าวต้มกุ้ง","เมนู Custom",
    "รายละเอียดอื่น"
  ];
  // Responsive-hidden details
  const hiddenHeaders=[
    "รวมรายการ","รวมชิ้น",
    "เวลารับ Order","Staff รับ Order",
    "เวลาเตรียม","Staff เตรียม Order",
    "เวลารับ Order ของ Department","Staff รับ Order ของ Department"
  ];

  const data=(rows||[]).map(r=>[
    actionCell(r[1]),
    r[0],r[1],r[2],r[3],r[4],r[5],r[6],r[7],r[8],r[9],
    orderSummary(r),
    r[10],r[11],r[12],r[13],r[14],
    r[23] || "",
    // hidden
    r[15],r[16],
    r[17],r[18],
    r[19],r[20],
    r[21],r[22]
  ]);

  const columns=[...mainHeaders.map(h=>({title:h,className:"all"})),...hiddenHeaders.map(h=>({title:h,className:"none"}))];

  if(datatable){ datatable.clear().rows.add(data).draw(); return; }

  datatable=$("#datatable").DataTable({
    data, columns,
    language:{url:"//cdn.datatables.net/plug-ins/1.10.24/i18n/Thai.json"},
    responsive:{details:{type:"inline"}},
    stateSave:true, deferRender:true,
    pageLength:25, lengthMenu:[[10,25,50,100],[10,25,50,100]],
    order:[[1,"desc"]],
    columnDefs:[
      {targets:[0],orderable:false,searchable:false},
      {targets:[2],render:(d)=>isPending(d)?'<span class="badge bg-warning text-dark">🔔 Pending</span>':d}
    ],
    rowCallback:(row,rowData)=>{ if(isPending(rowData[2])) $(row).addClass("pending-row"); }
  });

  $("#datatable").on("click","button[data-action]", async function(){
    const action=this.getAttribute("data-action");
    const row=datatable.row($(this).closest("tr")).data();
    const id=Number(row[1]);
    if(action==="slip") return downloadSlip(id);           // ✅ no passcode
    if(action==="step0") return approveStep(id,0,"สำหรับ Food House เมื่อรับ Order อาหารแล้ว");
    if(action==="step1") return approveStep(id,1,"สำหรับ Food House เมื่อเตรียมอาหารเสร็จแล้ว");
    if(action==="step2") return approveStep(id,2,"สำหรับ Department");
  });
}

// ----- refresh loops -----
async function refreshAll(){ const d=await apiGet("orders"); buildTable(d.rows); }
async function refreshPending(){
  const d=await apiGet("pendingCount");
  const count=Number(d.pendingCount||0);
  showIndicator(count);
  if(count>lastPending){
    const ok=await playOnce();
    if(!ok && document.hidden) notifyOS(count);
  }
  lastPending=count;
  scheduleAlarm();
}
async function versionLoop(){
  try{
    const d=await apiGet("version");
    const v=Number(d.version||0);
    if(v!==lastVersion){
      lastVersion=v;
      await refreshAll();
      await refreshPending();
    }
  }catch(e){ /* ignore */ }
  setTimeout(versionLoop, 4000);
}

// ----- actions -----
async function approveStep(id, step, label){
  const { value: passcode } = await Swal.fire({
    position:"top",
    title:"กรอกรหัสสำหรับการอนุมัติ",
    input:"password",
    inputLabel: label,
    inputPlaceholder:"กรุณากรอกรหัสผ่าน",
    allowOutsideClick:false,
    confirmButtonColor:"#0033A0",
    confirmButtonText:"ตกลง",
    inputAttributes:{ maxlength:20, autocapitalize:"off", autocorrect:"off" }
  });
  if(!passcode) return;
  try{
    Swal.fire({title:"กำลังบันทึก...", allowOutsideClick:false, didOpen:()=>Swal.showLoading()});
    const res=await apiPost("updateStatus",{id,step,passcode});
    Swal.close();
    Swal.fire({
      icon:res.warn?"warning":"success",
      title:res.warn?"อัปเดตสำเร็จ (มีคำเตือน)":"อัปเดตเรียบร้อย",
      text:res.warn||"",
      timer:res.warn?1600:900,
      showConfirmButton:!!res.warn
    });
    await refreshAll();
    await refreshPending();
  }catch(e){
    Swal.close();
    Swal.fire({icon:"error",title:"ผิดพลาด",text:e.message||"โปรดลองใหม่"});
  }
}

// ✅ Download slip WITHOUT passcode
async function downloadSlip(id){
  try{
    Swal.fire({title:"กำลังสร้างสลิป...", allowOutsideClick:false, didOpen:()=>Swal.showLoading()});
    const res=await apiPost("slip",{id}); // no passcode
    Swal.close();
    const obj=res.data;
    const a=document.createElement("a");
    a.href="data:application/pdf;base64,"+obj.b64;
    a.download=obj.filename||("MealSlip_"+id+".pdf");
    document.body.appendChild(a); a.click(); a.remove();
  }catch(e){
    Swal.close();
    Swal.fire({icon:"error",title:"ล้มเหลว",text:e.message||"โปรดลองใหม่"});
  }
}

async function boot(){
  assertConfig();

  // Apply branding if provided
  if(CFG.BRAND_TITLE) document.getElementById("brandTitle").textContent = CFG.BRAND_TITLE;
  if(CFG.BRAND_LOGO_URL) document.getElementById("brandLogo").src = CFG.BRAND_LOGO_URL;
  document.getElementById("envLabel").textContent = CFG.ENV_LABEL || "";

  initSoundUI();

  // load alarm mp3 URL from backend (optional)
  try{
    const alarm=await apiGet("alarmUrl");
    alarmMp3Url=alarm.alarmMp3Url||"";
    if(document.getElementById("soundSelect").value==="notification" && alarmMp3Url) audioEl().src=alarmMp3Url;
  }catch(e){ alarmMp3Url=""; }

  await refreshAll();
  await refreshPending();

  try{ const v=await apiGet("version"); lastVersion=Number(v.version||0); }catch(e){ lastVersion=0; }
  versionLoop();
}
document.addEventListener("DOMContentLoaded", boot);
