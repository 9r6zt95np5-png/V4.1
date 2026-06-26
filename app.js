
// Auto-format HH:MM:SS while typing in Tempo macchina.
// The input must be type="tel", not number, otherwise iPhone rejects ":".
document.addEventListener("input", (e) => {
  if(!e.target || e.target.id !== "machineHoursInput") return;

  const digits = e.target.value.replace(/\D/g, "").slice(0, 6);
  let out = digits;

  if(digits.length > 4){
    out = digits.slice(0,2) + ":" + digits.slice(2,4) + ":" + digits.slice(4);
  } else if(digits.length > 2){
    out = digits.slice(0,2) + ":" + digits.slice(2);
  }

  e.target.value = out;
});


function parseMachineTime(v){
  const m=String(v).trim().match(/^(\d{1,3}):(\d{2}):(\d{2})$/);
  if(!m) return null;
  return Number(m[1])*3600+Number(m[2])*60+Number(m[3]);
}
function fmtHMS(sec){
  sec=Math.max(0,Math.floor(sec));
  const h=Math.floor(sec/3600), mi=Math.floor((sec%3600)/60), s=sec%60;
  return `${String(h).padStart(2,"0")}:${String(mi).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}
const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const STORE = "tablettracking.v126a";

const defaultState = () => ({
  machines: defaultMachines(),
  products: [],
  alerts: [],
  feedback: [],
  shiftEnd: null,
  currentView: "dashboard"
});


function defaultMachines(){
  return [
    {name:"Macchina 1"},
    {name:"Macchina 2"},
    {name:"Macchina 3"},
    {name:"Macchina 4"}
  ];
}

function ensureFourMachines(){
  state.machines ||= defaultMachines();
  for(let i=0;i<4;i++){
    state.machines[i] ||= {name:`Macchina ${i+1}`};
    state.machines[i].name ||= `Macchina ${i+1}`;
  }
  if(state.machines.length < 4){
    while(state.machines.length < 4) state.machines.push({name:`Macchina ${state.machines.length+1}`});
  }
}

let state;
try { state = JSON.parse(localStorage.getItem(STORE)) || defaultState(); }
catch { state = defaultState(); }
ensureFourMachines();
state.products ||= [];
state.alerts ||= [];
state.feedback ||= [];

function save(){ localStorage.setItem(STORE, JSON.stringify(state)); }
function pad(n){ return String(n).padStart(2,"0"); }
function fmtTime(d){ return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function fmtHM(d){ return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fmtDuration(ms){
  if(ms <= 0) return "00:00:00";
  const s = Math.floor(ms/1000);
  return `${pad(Math.floor(s/3600))}:${pad(Math.floor((s%3600)/60))}:${pad(s%60)}`;
}
function num(v){ return Number(v || 0); }

function nextShiftDate(hhmm){
  const [h,m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h,m,0,0);
  if(d <= new Date()) d.setDate(d.getDate()+1);
  return d.toISOString();
}

function manualTimeToDate(value){
  const match = String(value || "").trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if(!match) return null;
  const d = new Date();
  d.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return d;
}

function calculateBin(machine){
  const counter = num(machine.counter);
  const rate = num(machine.rate);
  const bin = num(machine.bin);
  const margin = num(machine.margin);
  if(rate <= 0 || bin <= 0 || !machine.lastUpdateAt) return null;

  const nextMultiple = Math.floor(counter / bin + 1) * bin;
  const alertCounter = Math.max(nextMultiple - margin, counter);
  const missing = Math.max(0, alertCounter - counter);
  const baseTime = new Date(machine.lastUpdateAt);
  const ms = missing / rate * 3600000;
  const at = new Date(baseTime.getTime() + ms);
  return {type:"bin", title:`Cambio fusto — ${machine.name || "Macchina"}`, at, nextMultiple, alertCounter, missing, baseTime, totalMs:ms};
}

function buildBinSchedule(machine, limit=20){
  const calc = calculateBin(machine);
  if(!calc) return [];
  const rate = num(machine.rate);
  const bin = num(machine.bin);
  const margin = num(machine.margin);
  const counter = num(machine.counter);
  const out = [];
  for(let i=0;i<limit;i++){
    const target = calc.nextMultiple + bin*i;
    const alertCounter = target - margin;
    const missing = Math.max(0, alertCounter - counter);
    const at = new Date(calc.baseTime.getTime() + missing / rate * 3600000);
    if(state.shiftEnd && at > new Date(state.shiftEnd)) break;
    out.push({target, alertCounter, at});
  }
  return out;
}

function nextAlert(alert){
  const machine = state.machines[alert.machineIndex] || {};
  const titleBase = `${alert.name} — ${machine.name || `Macchina ${num(alert.machineIndex)+1}`}`;

  // Uniformità: calcolo sulle ore macchina, sempre ogni 8 ore macchina.
  // Esempio: ore macchina 14 -> prossima soglia 16 -> mancano 2 ore.
  if(alert.name === "Uniformità" && alert.mode === "machineHours"){
    const current = Number(alert.machineHours || 0);
    if(Number.isNaN(current)) return null;

    const interval = 8;
    const nextThreshold = Math.floor(current / interval + 1) * interval;
    const missingHours = Math.max(0, nextThreshold - current);
    const base = new Date(alert.updatedAt || Date.now());
    const at = new Date(base.getTime() + missingHours * 3600000);

    return {
      type:"uniformita",
      title:`Uniformità — ${machine.name || `Macchina ${num(alert.machineIndex)+1}`}`,
      at,
      alert,
      nextThreshold,
      missingHours
    };
  }

  // Uniformità per compresse: calcolo in base al contatore e alla produzione/ora della macchina.
  if(alert.name === "Uniformità per compresse"){
    const machine = state.machines[alert.machineIndex] || {};
    const rate = Number(machine.rate || alert.rate || 0);
    const currentCounter = Number(alert.counter || 0);
    const targetCounter = Number(alert.targetCounter || 0);

    if(rate <= 0 || targetCounter <= currentCounter) return null;

    const missingTablets = targetCounter - currentCounter;
    const base = new Date(alert.updatedAt || Date.now());
    const at = new Date(base.getTime() + (missingTablets / rate) * 3600000);
    const machineName = state.machines[alert.machineIndex]?.name || `Macchina ${Number(alert.machineIndex)+1}`;

    return {
      type:"uniformita",
      title:`Uniformità per compresse — ${machineName}`,
      at,
      alert,
      targetCounter,
      missingTablets
    };
  }

  // Altri avvisi: calcolo classico da ultimo orario fatto + frequenza.
  if(!alert.lastAt || !alert.intervalMinutes) return null;
  const at = new Date(new Date(alert.lastAt).getTime() + num(alert.intervalMinutes)*60000);
  const type = "extra";
  return {type, title:titleBase, at, alert};
}

function allEvents(){
  const events = [];
  state.machines.forEach(m=>{
    if(m.paused) return;
    const bin = calculateBin(m);
    if(bin) events.push(bin);
  });
  state.alerts.forEach(a=>{
    const ev = nextAlert(a);
    if(ev) events.push(ev);
  });
  return events.sort((a,b)=>a.at-b.at);
}

function fillProducts(){
  $$(".productSelect").forEach(sel=>{
    const current = sel.value;
    sel.innerHTML = `<option value="">Seleziona prodotto</option>` +
      state.products.map((p,i)=>`<option value="${i}">${escapeHtml(p.name)}</option>`).join("");
    sel.value = current;
  });
}

function escapeHtml(str){
  return String(str ?? "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}


function machineDisplayName(index){
  return state.machines[index]?.name || `Macchina ${Number(index)+1}`;
}

function refreshMachineNameSelects(){
  const productMachine = $("#productMachine");
  if(productMachine){
    const current = productMachine.value || "0";
    productMachine.innerHTML = [0,1,2,3].map(i => `<option value="${i}">${machineDisplayName(i)}</option>`).join("");
    productMachine.value = current;
  }

  const alertMachine = $("#alertMachine");
  if(alertMachine){
    const current = alertMachine.value || "0";
    alertMachine.innerHTML = [0,1,2,3].map(i => `<option value="${i}">${machineDisplayName(i)}</option>`).join("");
    alertMachine.value = current;
  }

  $$(".machine-jump").forEach(btn => {
    const i = Number(btn.dataset.targetMachine);
    const name = machineDisplayName(i);
    btn.textContent = name.length > 12 ? name.slice(0, 11) + "…" : name;
  });
}

function hydrate(){
  fillProducts();
  $("#shiftEndDisplay").value = state.shiftEnd ? fmtTime(new Date(state.shiftEnd)) : "";
  $$(".machine").forEach(card=>{
    const i = num(card.dataset.machine);
    const m = state.machines[i] || {};
    $(".machine-name", card).value = m.name || `Macchina ${i+1}`;
    $(".counter", card).value = m.counter ?? "";
    $(".rate", card).value = m.rate ?? "";
    $(".bin", card).value = m.bin ?? "";
    $(".margin", card).value = m.margin ?? 0;
    $(".pauseMachine", card).textContent = m.paused ? "Riprendi" : "Macchina ferma";
  });
  refreshMachineNameSelects();
  renderProducts();
  renderAlerts();
  renderFeedback();
}

function readFields(card){
  return {
    name: $(".machine-name",card).value || `Macchina ${num(card.dataset.machine)+1}`,
    counter: num($(".counter",card).value),
    rate: num($(".rate",card).value),
    bin: num($(".bin",card).value),
    margin: num($(".margin",card).value)
  };
}


function chooseStartMode(){
  return new Promise(resolve => {
    const modal = $("#startModal");
    modal.classList.remove("hidden");

    const cleanup = (value) => {
      modal.classList.add("hidden");
      $("#startNowChoice").onclick = null;
      $("#startManualChoice").onclick = null;
      $("#startCancelChoice").onclick = null;
      resolve(value);
    };

    $("#startNowChoice").onclick = () => cleanup("now");
    $("#startManualChoice").onclick = () => cleanup("manual");
    $("#startCancelChoice").onclick = () => cleanup(null);
  });
}

async function startMachine(card){
  const choice = await chooseStartMode();
  if(choice === null) return;

  let start;
  if(choice === "now"){
    start = new Date();
  } else if(choice === "manual"){
    const value = prompt("Inserisci orario di partenza manuale (HH:MM)", "");
    start = manualTimeToDate(value);
    if(!start){
      alert("Formato non valido. Esempio corretto: 22:00");
      return;
    }
  }

  const data = readFields(card);
  if(data.rate <= 0 || data.bin <= 0){ alert("Inserisci produzione/ora e capacità fusto."); return; }

  const i = num(card.dataset.machine);
  state.machines[i] = {...(state.machines[i]||{}), ...data, lastUpdateAt:start.toISOString(), paused:false};
  save();
  alert(`Macchina avviata con ora di partenza: ${fmtTime(start)}`);
  hydrate();
  render();
}

function updateCounter(card, reason="aggiornamento"){
  const i = num(card.dataset.machine);
  const m = state.machines[i] || {};
  const old = num(m.counter);
  const valueRaw = prompt(`Inserisci il contatore reale (${reason}):`, old || "");
  if(valueRaw === null) return false;
  const value = Number(valueRaw);
  if(Number.isNaN(value)){ alert("Contatore non valido."); return false; }
  if(value < old && !confirm("Il nuovo contatore è inferiore al precedente. Confermi?")) return false;

  $(".counter", card).value = value;
  const data = readFields(card);
  state.machines[i] = {...m, ...data, counter:value, lastUpdateAt:new Date().toISOString(), paused:false};
  save();
  hydrate();
  render();
  return true;
}

function render(){
  const events = allEvents();
  const top = events[0];
  $("#priorityCard").classList.remove("uniformita","extra","badSoon");
  if(top){
    $("#priorityTitle").textContent = top.title;
    $("#priorityCountdown").textContent = fmtDuration(top.at - new Date());
    $("#priorityTime").textContent = `Ora: ${fmtTime(top.at)}`;
    if(top.type) $("#priorityCard").classList.add(top.type);
  } else {
    $("#priorityTitle").textContent = "Configura il turno";
    $("#priorityCountdown").textContent = "--:--:--";
    $("#priorityTime").textContent = "Ora: --";
  }

  $$(".machine").forEach(card=>{
    const i = num(card.dataset.machine);
    const m = state.machines[i] || {};
    const calc = calculateBin(m);
    card.classList.toggle("paused", !!m.paused);
    card.classList.remove("warn","bad");
    $(".machine-status",card).textContent = m.paused ? "Ferma" : (calc ? "In produzione" : "Non avviata");

    if(!calc || m.paused){
      $(".countdown",card).textContent = m.paused ? "FERMA" : "--:--:--";
      $(".changeTime",card).textContent = "Ora: --";
      $(".changeCounter",card).textContent = "Contatore: --";
      $(".bar i",card).style.width = "0%";
      $(".schedule",card).innerHTML = "";
    } else {
      const remaining = calc.at - new Date();
      $(".countdown",card).textContent = fmtDuration(remaining);
      $(".changeTime",card).textContent = `Ora: ${fmtTime(calc.at)}`;
      $(".changeCounter",card).textContent =
        `Cambio: ${calc.nextMultiple.toLocaleString("it-IT")} · Avviso: ${calc.alertCounter.toLocaleString("it-IT")}`;
      const elapsed = Date.now() - calc.baseTime.getTime();
      const progress = calc.totalMs > 0 ? Math.min(100, Math.max(0, elapsed / calc.totalMs * 100)) : 100;
      $(".bar i",card).style.width = `${progress}%`;
      if(remaining <= 2*60000) card.classList.add("bad");
      else if(remaining <= 10*60000) card.classList.add("warn");
      $(".schedule",card).innerHTML = buildBinSchedule(m).map(x=>`<li>${fmtTime(x.at)} — ${x.target.toLocaleString("it-IT")}</li>`).join("");
    }

    const machineAlerts = state.alerts.filter(a=>num(a.machineIndex)===i).map(a=>{
      const ev = nextAlert(a);
      return ev ? `<div class="alert-mini"><b>${escapeHtml(a.name)}</b> · ${fmtDuration(ev.at-new Date())} · ${fmtTime(ev.at)}</div>` : "";
    }).join("");
    $(".machine-alerts",card).innerHTML = machineAlerts;
  });

  renderAlerts(false);
}

function renderProducts(){
  const list = $("#productList");
  if(!list) return;
  if(!state.products.length){ list.innerHTML = "<p class='hint'>Nessun prodotto salvato.</p>"; return; }
  list.innerHTML = state.products.map((p,i)=>`
    <div class="list-item">
      <b>${escapeHtml(p.name)}</b>
      <span>${num(p.rate).toLocaleString("it-IT")}/h · fusto ${num(p.bin).toLocaleString("it-IT")} · margine ${num(p.margin).toLocaleString("it-IT")}</span>
      <div class="row">
        <button class="btn secondary" data-load-product="${i}">Modifica</button>
        <button class="btn ghost danger" data-delete-product="${i}">Elimina</button>
      </div>
    </div>
  `).join("");
  $$("[data-delete-product]").forEach(b=>b.onclick=()=>{ if(confirm("Eliminare prodotto?")){ state.products.splice(num(b.dataset.deleteProduct),1); save(); fillProducts(); renderProducts(); }});
  $$("[data-load-product]").forEach(b=>b.onclick=()=>{
    const p = state.products[num(b.dataset.loadProduct)];
    $("#productName").value=p.name; $("#productRate").value=p.rate; $("#productBin").value=p.bin; $("#productMargin").value=p.margin||0; $("#productMachine").value=p.preferredMachine??"0";
    state.editProductIndex = num(b.dataset.loadProduct); save();
    alert("Prodotto caricato. Modifica i dati e premi Salva prodotto.");
  });
}

function renderAlerts(updateList=true){
  if(!updateList) return;
  const list = $("#alertList");
  if(!list) return;
  if(!state.alerts.length){ list.innerHTML = "<p class='hint'>Nessun avviso attivo.</p>"; return; }

  list.innerHTML = state.alerts.map((a,i)=>{
    const ev = nextAlert(a);
    const machineName = state.machines[a.machineIndex]?.name || machineDisplayName(a.machineIndex);

    if(a.name === "Uniformità" && a.mode === "machineHours"){
      return `<div class="alert-item">
        <b>Uniformità — ${escapeHtml(machineName)}</b>
        <span>Ore macchina attuali: ${Number(a.machineHours || 0).toLocaleString("it-IT")}</span>
        <span>Prossima soglia: ${ev ? ev.nextThreshold.toLocaleString("it-IT") : "--"} ore macchina</span>
        <span>Mancano ${ev ? fmtDuration(ev.at - new Date()) : "--:--:--"} · previsto ${ev ? fmtTime(ev.at) : "--"}</span>
        <div class="uniformity-note">Regola: ogni 8 ore macchina</div>
        <div class="row">
          <button class="btn secondary" data-alert-hours="${i}">Aggiorna ore macchina</button>
          <button class="btn ghost danger" data-alert-delete="${i}">Elimina</button>
        </div>
      </div>`;
    }

    if(a.name === "Uniformità per compresse"){
      return `<div class="alert-item">
        <b>Uniformità per compresse — ${escapeHtml(machineName)}</b>
        <span>Contatore attuale: ${Number(a.counter || 0).toLocaleString("it-IT")}</span>
        <span>Controllo a: ${Number(a.targetCounter || 0).toLocaleString("it-IT")} compresse</span>
        <span>Mancano: ${ev ? Number(ev.missingTablets).toLocaleString("it-IT") : "--"} compresse · previsto ${ev ? fmtTime(ev.at) : "--"}</span>
        <div class="uniformity-note">Calcolo basato sulla produzione/ora della macchina</div>
        <div class="row">
          <button class="btn secondary" data-alert-counter="${i}">Aggiorna contatore</button>
          <button class="btn ghost danger" data-alert-delete="${i}">Elimina</button>
        </div>
      </div>`;
    }

    return `<div class="alert-item">
      <b>${escapeHtml(a.name)} — ${escapeHtml(machineName)}</b>
      <span>Ogni ${(num(a.intervalMinutes)/60).toLocaleString("it-IT")} ore · prossimo ${ev ? fmtTime(ev.at) : "--"}</span>
      <span>Mancano ${ev ? fmtDuration(ev.at - new Date()) : "--:--:--"}</span>
      <div class="row">
        <button class="btn secondary" data-alert-done="${i}">Fatto ora</button>
        <button class="btn ghost danger" data-alert-delete="${i}">Elimina</button>
      </div>
    </div>`;
  }).join("");

  $$("[data-alert-done]").forEach(b=>b.onclick=()=>{
    state.alerts[num(b.dataset.alertDone)].lastAt = new Date().toISOString();
    save(); renderAlerts(); render();
  });

  $$("[data-alert-hours]").forEach(b=>b.onclick=()=>{
    const i = num(b.dataset.alertHours);
    const old = state.alerts[i].machineHours ?? "";
    const value = prompt("Inserisci ore macchina attuali, esempio 14 oppure 14.5", old);
    if(value === null) return;
    const hours = Number(String(value).replace(",", "."));
    if(Number.isNaN(hours) || hours < 0){ alert("Ore macchina non valide."); return; }
    state.alerts[i].machineHours = hours;
    state.alerts[i].updatedAt = new Date().toISOString();
    save(); renderAlerts(); render();
  });

  $$("[data-alert-counter]").forEach(b=>b.onclick=()=>{
    const i = num(b.dataset.alertCounter);
    const old = state.alerts[i].counter ?? "";
    const value = prompt("Inserisci contatore attuale", old);
    if(value === null) return;
    const counter = Number(value);
    if(Number.isNaN(counter) || counter < 0){ alert("Contatore non valido."); return; }
    state.alerts[i].counter = counter;
    state.alerts[i].updatedAt = new Date().toISOString();
    save(); renderAlerts(); render();
  });

  $$("[data-alert-delete]").forEach(b=>b.onclick=()=>{
    if(confirm("Eliminare avviso?")){
      state.alerts.splice(num(b.dataset.alertDelete),1);
      save(); renderAlerts(); render();
    }
  });
}

function renderFeedback(){
  const list = $("#feedbackList");
  if(!list) return;
  if(!state.feedback.length){ list.innerHTML = "<p class='hint'>Nessun feedback salvato.</p>"; return; }
  list.innerHTML = state.feedback.map((f,i)=>`<div class="feedback-item"><b>${new Date(f.at).toLocaleString("it-IT")}</b><span>${escapeHtml(f.text)}</span><div class="row"><button class="btn ghost danger" data-feedback-delete="${i}">Elimina</button></div></div>`).join("");
  $$("[data-feedback-delete]").forEach(b=>b.onclick=()=>{ state.feedback.splice(num(b.dataset.feedbackDelete),1); save(); renderFeedback(); });
}

$$(".tab").forEach(btn=>{
  btn.onclick = () => {
    $$(".tab").forEach(x=>x.classList.remove("active"));
    btn.classList.add("active");
    const view = btn.dataset.view;
    ["dashboard","products","alerts","backup"].forEach(v=>$("#"+v+"View").classList.toggle("hidden", v!==view));
    state.currentView = view; save();
    renderAlerts();
    renderFeedback();
  };
});

$$("[data-shift]").forEach(btn=>btn.onclick=()=>{
  state.shiftEnd = nextShiftDate(btn.dataset.shift);
  $("#shiftEndDisplay").value = fmtTime(new Date(state.shiftEnd));
  save();
  render();
  alert(`Fine turno impostata: ${fmtTime(new Date(state.shiftEnd))}`);
});


$("#endShiftBtn").onclick = () => {
  if(confirm("Vuoi azzerare il turno? Prodotti e avvisi restano salvati.")){
    state.machines = [0,1,2,3].map(i => ({name: state.machines[i]?.name || `Macchina ${i+1}`}));
    state.shiftEnd = null;
    save();
    hydrate(); render();
  }
};

$$(".startMachine").forEach(btn=>btn.onclick=e=>startMachine(e.target.closest(".machine")));
$$(".updateCounter").forEach(btn=>btn.onclick=e=>updateCounter(e.target.closest(".machine"), "aggiornamento manuale"));
$$(".pauseMachine").forEach(btn=>btn.onclick=e=>{
  const card = e.target.closest(".machine");
  const i = num(card.dataset.machine);
  const m = state.machines[i] ||= {};
  if(!m.paused){
    m.paused = true; save(); hydrate(); render();
  } else {
    updateCounter(card, "ripartenza macchina");
  }
});


$$(".resetMachine").forEach(btn=>{
  btn.onclick = e => {
    const card = e.target.closest(".machine");
    const i = Number(card.dataset.machine);
    const oldName = state.machines[i]?.name || `Macchina ${i+1}`;

    if(!confirm(`Azzerare solo ${oldName}? Le altre macchine non verranno modificate.`)) return;

    state.machines[i] = { name: oldName };

    $(".counter",card).value = "";
    $(".rate",card).value = "";
    $(".bin",card).value = "";
    $(".margin",card).value = 0;

    const productSelect = $(".productSelect", card);
    if(productSelect) productSelect.value = "";

    const pauseBtn = $(".pauseMachine", card);
    if(pauseBtn) pauseBtn.textContent = "Macchina ferma";

    save();
    hydrate();
    render();
    alert(`${oldName} azzerata.`);
  };
});

$$(".productSelect").forEach(sel=>sel.onchange=e=>{
  const p = state.products[num(e.target.value)];
  if(!p) return;
  const card = e.target.closest(".machine");
  $(".rate",card).value = p.rate;
  $(".bin",card).value = p.bin;
  $(".margin",card).value = p.margin || 0;
});

$("#saveProductBtn").onclick = () => {
  const p = {
    name: $("#productName").value.trim(),
    rate: num($("#productRate").value),
    bin: num($("#productBin").value),
    margin: num($("#productMargin").value),
    preferredMachine: $("#productMachine").value
  };
  if(!p.name || p.rate<=0 || p.bin<=0){ alert("Inserisci nome prodotto, produzione e capacità fusto."); return; }
  if(Number.isInteger(state.editProductIndex)){
    state.products[state.editProductIndex] = p;
    delete state.editProductIndex;
  } else state.products.push(p);
  save();
  $("#productName").value=""; $("#productRate").value=""; $("#productBin").value=""; $("#productMargin").value=0;
  fillProducts(); renderProducts();
  alert("Prodotto salvato.");
};

$("#lastNowBtn").onclick = () => $("#alertLastTime").value = fmtHM(new Date());

$("#addAlertBtn").onclick = () => {
  const name = $("#alertName").value;
  const machineIndex = num($("#alertMachine").value);

  if(name === "Uniformità"){
    const raw=$("#machineHoursInput").value;
    const machineSeconds=parseMachineTime(raw);
    if(machineSeconds===null){alert("Inserisci il tempo macchina nel formato HH:MM:SS, esempio 13:25:19");return;}
    const machineHours=machineSeconds/3600;

    state.alerts.push({
      name:"Uniformità",
      machineIndex,
      mode:"machineHours",
      machineHours,
      updatedAt:new Date().toISOString()
    });

    save();
    $("#machineHoursInput").value = "";
    renderAlerts();
    render();
    alert("Uniformità aggiunta. Regola: prossimo scaglione multiplo di 8 ore macchina.");
    return;
  }

  if(name === "Uniformità per compresse"){
    const machineIndex = Number($("#alertMachine").value);
    const machine = state.machines[machineIndex] || {};
    const rate = Number(machine.rate || 0);

    if(rate <= 0){
      alert("Prima inserisci la produzione/ora nella macchina scelta, oppure seleziona un prodotto.");
      return;
    }

    const targetCounter = Number($("#uniformityTabletsInput").value);
    let counter = $("#uniformityCounterInput").value === "" ? Number(machine.counter || 0) : Number($("#uniformityCounterInput").value);

    if(!targetCounter || targetCounter <= 0){
      alert("Inserisci il numero di compresse a cui vuoi fare il controllo.");
      return;
    }

    if(Number.isNaN(counter) || counter < 0){
      alert("Contatore attuale non valido.");
      return;
    }

    if(targetCounter <= counter){
      alert("Il numero di compresse del controllo deve essere superiore al contatore attuale.");
      return;
    }

    state.alerts.push({
      name:"Uniformità per compresse",
      machineIndex,
      targetCounter,
      counter,
      rate,
      updatedAt:new Date().toISOString()
    });

    $("#uniformityTabletsInput").value = "";
    $("#uniformityCounterInput").value = "";

    save();
    renderAlerts();
    render();
    alert("Uniformità per compresse aggiunta.");
    return;
  }

  const hours = Number($("#alertHours").value);
  const time = $("#alertLastTime").value;
  if(!name || hours <= 0 || !time){ alert("Inserisci tipo avviso, frequenza e ultimo orario fatto."); return; }
  const last = manualTimeToDate(time);
  if(!last){ alert("Orario ultimo controllo non valido."); return; }
  if(last > new Date()) last.setDate(last.getDate()-1);
  state.alerts.push({name, machineIndex, intervalMinutes: hours*60, lastAt: last.toISOString()});
  save();
  $("#alertLastTime").value="";
  renderAlerts(); render();
  alert("Avviso aggiunto.");
};

function updateAlertFormMode(){
  const selected = $("#alertName").value;
  const isUniformity = selected === "Uniformità";
  const isUniformityTablets = selected === "Uniformità per compresse";
  const isSpecial = isUniformity || isUniformityTablets;

  $("#machineHoursWrap").classList.toggle("hidden", !isUniformity);
  $("#uniformityTabletsWrap")?.classList.toggle("hidden", !isUniformityTablets);
  $("#uniformityCounterWrap")?.classList.toggle("hidden", !isUniformityTablets);

  $("#alertHoursWrap").classList.toggle("hidden", isSpecial);
  $("#alertLastTimeWrap").classList.toggle("hidden", isSpecial);
  $("#lastNowBtn").classList.toggle("hidden", isSpecial);
}

$("#alertName").addEventListener("change", updateAlertFormMode);
updateAlertFormMode();

$("#exportBtn").onclick = () => {
  const blob = new Blob([JSON.stringify(state,null,2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "TabletTracking_backup.json";
  a.click();
  URL.revokeObjectURL(a.href);
};

$("#importFile").onchange = async e => {
  const file = e.target.files[0];
  if(!file) return;
  try{
    const imported = JSON.parse(await file.text());
    if(!confirm("Importare questo backup e sostituire i dati attuali?")) return;
    state = {...defaultState(), ...imported};
    save();
    hydrate(); render();
    alert("Backup importato.");
  }catch(err){ alert("File backup non valido."); }
};

$("#saveFeedbackBtn").onclick = () => {
  const text = $("#feedbackText").value.trim();
  if(!text) return;
  state.feedback.push({text, at:new Date().toISOString()});
  $("#feedbackText").value="";
  save();
  renderFeedback();
};


// Dashboard: swipe or tap to switch machine cards
function setupMachineScroller(){
  const scroller = $("#machinesScroller");
  if(!scroller) return;

  const buttons = $$(".machine-jump");

  buttons.forEach(btn => {
    btn.onclick = () => {
      const index = Number(btn.dataset.targetMachine);
      const card = $(`.machine[data-machine="${index}"]`);
      if(card) card.scrollIntoView({behavior:"smooth", inline:"start", block:"nearest"});
    };
  });

  scroller.addEventListener("scroll", () => {
    const cards = $$(".machine", scroller);
    let activeIndex = 0;
    let best = Infinity;

    cards.forEach(card => {
      const distance = Math.abs(card.getBoundingClientRect().left - scroller.getBoundingClientRect().left);
      if(distance < best){
        best = distance;
        activeIndex = Number(card.dataset.machine);
      }
    });

    buttons.forEach(b => b.classList.toggle("active", Number(b.dataset.targetMachine) === activeIndex));
  }, {passive:true});
}

setupMachineScroller();

if("serviceWorker" in navigator){
  window.addEventListener("load",()=>navigator.serviceWorker.register("./service-worker.js?v=126a").catch(()=>{}));
}

hydrate();
render();
setInterval(()=>{ render(); renderAlerts(true); },1000);


document.addEventListener("change", (event) => {
  if(event.target && event.target.classList.contains("machine-name")){
    setTimeout(() => {
      $$(".machine").forEach(card => {
        const i = Number(card.dataset.machine);
        if(state.machines[i]){
          state.machines[i].name = $(".machine-name", card).value || `Macchina ${i+1}`;
        }
      });
      save();
      refreshMachineNameSelects();
      renderAlerts();
      renderProducts();
      render();
    }, 0);
  }
});
