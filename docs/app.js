const API_BASE = window.APP_CONFIG.API_BASE_URL;

async function apiGet(action){
  const url = new URL(API_BASE);
  url.searchParams.set("action", action);
  const res = await fetch(url);
  const j = await res.json();
  if(!j.ok) throw new Error(j.error?.message || "API error");
  return j.data;
}

function buildTable(rows){
  const data = rows.map(r => r.slice(0, 15));
  const headers = ["ID","สถานะ","วันที่","HN","ชื่อผู้ป่วย","วันเกิด","แพ้อาหาร","โรคประจำตัว","ผู้ส่ง","แผนก","ทูน่า","ปลา","ไก่","กุ้ง","Custom"]
    .map(h => ({title:h}));

  $('#datatable').DataTable({
    data,
    columns: headers,
    destroy:true,
    responsive:true
  });
}

async function boot(){
  const data = await apiGet("orders");
  buildTable(data.rows);
}

document.addEventListener("DOMContentLoaded", boot);
