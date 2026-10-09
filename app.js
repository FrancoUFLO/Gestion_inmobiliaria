/* Panel inmobiliario — aplicación local integrada
   Un único app.js. Datos persistidos en localStorage.
   Para producción: backend, base de datos, sesiones de servidor y RBAC.
*/
(() => {
  'use strict';

  const APP = 'raiz_propiedades_v2';
  const TRASH_DAYS = 15;
  const SESSION_MS = 30 * 60 * 1000;
  const PROPERTY_TYPES = ['Casa','Departamento','PH','Terreno','Local','Oficina','Galpón','Otro'];
  const SALE_STATUS = 'En venta'; // inmuebles en venta: sin inquilino ni control de alquiler, sólo datos del propietario
  const PROPERTY_STATUS = ['Disponible','Alquilado','Reservado',SALE_STATUS];
  const statusClass = s => String(s||'').replace(/\s+/g,'-'); // 'En venta' -> 'En-venta' (para usar en clases CSS)

  // Expensas: valores variables mes a mes. Se configura por propiedad (casilleros) y el
  // importe real se carga recién al generar el comprobante de pago de ese período.
  const EXPENSES_ORDINARY = [
    {key:'gas',label:'Gas'},
    {key:'abl',label:'ABL'},
    {key:'sanitarios',label:'Servicios sanitarios'},
    {key:'sueldoEncargado',label:'Sueldo del encargado'},
    {key:'limpiezaComun',label:'Limpieza de espacios comunes'},
    {key:'luzComun',label:'Luz de pasillos y áreas comunes'},
    {key:'ascensores',label:'Mantenimiento de ascensores'},
    {key:'seguridad',label:'Servicio de seguridad'},
    {key:'jardineria',label:'Jardinería'},
    {key:'seguroEdificio',label:'Seguro del edificio'},
    {key:'gastosAdmin',label:'Gastos administrativos habituales'},
    {key:'bombasPortones',label:'Mantenimiento básico de bombas o portones'}
  ];
  const EXPENSES_EXTRAORDINARY = [
    {key:'comisionInmobiliaria',label:'Comisión inmobiliaria'},
    {key:'cambioAscensor',label:'Cambio completo de ascensor'},
    {key:'reparacionesEstructurales',label:'Reparaciones estructurales'},
    {key:'impermeabilizacion',label:'Impermeabilización de terrazas'},
    {key:'obrasCanerias',label:'Obras grandes en cañerías'},
    {key:'renovacionFachada',label:'Renovación integral de fachada'},
    {key:'camarasSeguridad',label:'Instalación de cámaras o nuevos sistemas de seguridad'},
    {key:'juiciosConsorcio',label:'Juicios del consorcio'},
    {key:'fondosObras',label:'Fondos especiales para obras importantes'}
  ];
  function expenseLabel(group,key){ const list=group==='ordinary'?EXPENSES_ORDINARY:EXPENSES_EXTRAORDINARY; return list.find(x=>x.key===key)?.label||key; }
  let state = defaultState();
  let remoteRevision = 0;
  let saveQueue = Promise.resolve();
  let bootReady = false;
  let session = null;
  let view = 'properties';
  let inactivityTimer = null;
  let currentReceiptId = null;
  let activeContractId = null;
  let pendingBlankContract = false; // se activa con "+Nuevo" para forzar el editor vacío una sola vez
  const selectedPropertyIds = new Set();
  let lastDeletedTrashIds = []; // ids de papelera del último borrado, para el botón "Deshacer" del toast
  let propertyFilters = {search:'', status:'', type:'', sortKey:null, sortDir:'asc'}; // búsqueda/filtros/orden de la tabla de propiedades

  const $ = s => document.querySelector(s);
  const money = n => new Intl.NumberFormat('es-AR',{style:'currency',currency:'ARS',maximumFractionDigits:0}).format(Number(n)||0);
  const dateTime = iso => { const d=new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('es-AR',{dateStyle:'short',timeStyle:'short'}); };
  const fmtDateInput = (d=new Date()) => { const x=new Date(d); return new Date(x.getTime()-x.getTimezoneOffset()*60000).toISOString().slice(0,10); };
  const uid = p => `${p}_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
  const esc = v => String(v ?? '').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  const safeName = s => String(s||'archivo').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\w\-]+/g,'_').slice(0,50);
  // Período mensual normalizado para vincular pagos con el calendario de cobro.
  // Formato único: YYYY-MM.
  const periodKey = d => {
    const x = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(x.getTime())) return '';
    return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}`;
  };

  // --- Archivos adjuntos de contratos (PDF/Word) en IndexedDB ---
  // localStorage tiene un límite de ~5-10 MB por sitio. Guardar los archivos en base64
  // ahí dentro puede agotarlo con solo unos pocos contratos. Por eso el contenido del
  // archivo se guarda en IndexedDB y el estado que persiste en localStorage sólo
  // conserva el nombre/tipo de archivo (liviano) más una referencia por id de contrato.
  const FILES_DB='raiz_contract_files', FILES_STORE='files';
  let filesDbPromise=null;
  function openFilesDb(){
    if(filesDbPromise) return filesDbPromise;
    filesDbPromise=new Promise((resolve,reject)=>{
      if(!window.indexedDB){reject(new Error('IndexedDB no disponible'));return;}
      const req=indexedDB.open(FILES_DB,1);
      req.onupgradeneeded=()=>{ if(!req.result.objectStoreNames.contains(FILES_STORE)) req.result.createObjectStore(FILES_STORE); };
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
    return filesDbPromise;
  }
  async function idbSetFile(id,dataUrl){
    try{ const db=await openFilesDb(); return await new Promise((resolve,reject)=>{ const tx=db.transaction(FILES_STORE,'readwrite'); tx.objectStore(FILES_STORE).put(dataUrl,id); tx.oncomplete=()=>resolve(true); tx.onerror=()=>reject(tx.error); }); }
    catch(e){ recordAudit('SYSTEM_ERROR','No se pudo guardar el archivo adjunto: '+(e.message||e),'error'); return false; }
  }
  async function idbGetFile(id){
    try{ const db=await openFilesDb(); return await new Promise((resolve,reject)=>{ const tx=db.transaction(FILES_STORE,'readonly'); const req=tx.objectStore(FILES_STORE).get(id); req.onsuccess=()=>resolve(req.result||''); req.onerror=()=>reject(req.error); }); }
    catch(e){ return ''; }
  }
  async function idbDeleteFile(id){
    try{ const db=await openFilesDb(); return await new Promise((resolve,reject)=>{ const tx=db.transaction(FILES_STORE,'readwrite'); tx.objectStore(FILES_STORE).delete(id); tx.oncomplete=()=>resolve(true); tx.onerror=()=>reject(tx.error); }); }
    catch(e){ return false; }
  }
  // Recupera el archivo desde IndexedDB si el contrato tiene metadata de archivo pero
  // todavía no lo cargó en memoria en esta sesión (por ejemplo, tras recargar la página).
  async function ensureContractFileData(c){
    if(c && !c.fileData && c.fileName){ c.fileData=(await idbGetFile(c.id))||''; }
    return c?.fileData||'';
  }
  function contractWithoutFile(c){ if(!c||!c.fileData) return c; const clone={...c}; delete clone.fileData; return clone; }

  function defaultState(){
    return {version:5,accounts:[],currentAccount:null,properties:[],payments:[],receipts:[],contracts:[],trash:[],audit:[],backups:[],settings:{commissionPercent:5,sessionMinutes:30,rentIndices:{icl:[],ipc:[],casapropia:[],cac:[],is:[],ipim:[],cer:[],uva:[]}}};
  }
  function loadState(){ return defaultState(); }
  async function api(url,opts={}){
    const r=await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json'},...opts});
    const body=await r.json().catch(()=>({}));
    if(!r.ok)throw Object.assign(new Error(body.error||'Error de conexión'),{status:r.status});
    return body;
  }
  async function fetchRemote(){
    const [me,remote]=await Promise.all([api('/api/me'),api('/api/state')]);
    const account={id:me.user.id,inmobiliaria:me.user.organization,userName:me.user.name,email:me.user.email};
    state={...defaultState(),...remote.data,accounts:[account],currentAccount:account.id};
    remoteRevision=remote.revision;
    session={accountId:account.id,createdAt:Date.now(),lastActivity:Date.now()};
  }
  function saveState(){
    if(!bootReady||!session)return;
    const data={...state,accounts:[],currentAccount:null,
      contracts:state.contracts.map(contractWithoutFile),
      trash:state.trash.map(t=>Array.isArray(t?.linkedContracts)?{...t,linkedContracts:t.linkedContracts.map(contractWithoutFile)}:t)};
    saveQueue=saveQueue.then(async()=>{
      const result=await api('/api/state',{method:'PUT',body:JSON.stringify({data,revision:remoteRevision})});
      remoteRevision=result.revision;
    }).catch(async e=>{
      console.error('Error de sincronización:',e);
      if(e.status===409){bootReady=false;alert('Otro dispositivo modificó los datos. Se recargará la información para evitar sobrescribir cambios.');location.reload();}
      else toast('No se pudo sincronizar con el servidor. Revisá tu conexión.');
    });
  }
  function loadSession(){return null;}
  function saveSession(){}
  function currentAccount(){ return state.accounts.find(a=>a.id===session?.accountId)||null; }
  function accountId(){ return currentAccount()?.id||null; }
  function accountProperties(){ return state.properties.filter(p=>p.accountId===accountId()); }
  function accountPayments(){ return state.payments.filter(p=>p.accountId===accountId()); }
  function accountReceipts(){ return state.receipts.filter(r=>r.accountId===accountId()); }
  function accountContracts(){ return state.contracts.filter(c=>c.accountId===accountId()); }
  function propertyContract(p){ return accountContracts().find(c=>c.propertyId===p.id && c.active!==false); }
  function toast(msg,opts={}){
    const el=$('#toast'); if(!el)return;
    if(opts && opts.actionLabel && typeof opts.onAction==='function'){
      window.__toastAction=opts.onAction;
      el.innerHTML=`<span class="toast-msg">${esc(msg)}</span><button type="button" class="toast-undo" onclick="window.__toastAction&&window.__toastAction();window.__toastAction=null;this.closest('.toast').classList.remove('show')">${esc(opts.actionLabel)}</button>`;
    } else {
      el.textContent=msg;
    }
    el.classList.add('show'); clearTimeout(toast.t); toast.t=setTimeout(()=>el.classList.remove('show'),opts.duration||2800);
  }
  // Envuelve la acción de un botón mostrando "Procesando…" mientras se ejecuta (útil para
  // Excel/PDF, que a veces tardan y así se evitan dobles clics).
  window.withBusyButton=(btn,label,fn)=>{
    if(!btn){ fn(); return; }
    const original=btn.innerHTML, wasDisabled=btn.disabled;
    btn.disabled=true; btn.textContent=label||'Procesando…';
    setTimeout(()=>{
      const restore=()=>{ btn.disabled=wasDisabled; btn.innerHTML=original; };
      try{
        const result=fn();
        if(result && typeof result.then==='function') result.finally(restore); else restore();
      }catch(e){ restore(); throw e; }
    },10);
  };
  function recordAudit(action,detail,level='info',persist=true){
    state.audit.unshift({id:uid('log'),at:new Date().toISOString(),accountId:accountId(),action,detail,level});
    state.audit=state.audit.slice(0,1000); if(persist)saveState();
  }
  function snapshot(label){
    const own=accountId();
    const data={properties:state.properties.filter(p=>p.accountId===own),payments:state.payments.filter(p=>p.accountId===own),receipts:state.receipts.filter(r=>r.accountId===own),contracts:state.contracts.filter(c=>c.accountId===own),trash:state.trash.filter(t=>t.accountId===own),settings:state.settings};
    state.backups.unshift({id:uid('backup'),at:new Date().toISOString(),accountId:own,label,data:JSON.stringify(data)});
    state.backups=state.backups.slice(0,30); saveState();
  }
  function purgeTrash(){
    const cutoff=Date.now()-TRASH_DAYS*86400000;
    const before=state.trash.length;
    const removed=state.trash.filter(x=>new Date(x.deletedAt).getTime()<=cutoff);
    state.trash=state.trash.filter(x=>new Date(x.deletedAt).getTime()>cutoff);
    removed.forEach(t=>(t.linkedContracts||[]).forEach(c=>{ if(c.fileName) idbDeleteFile(c.id); }));
    if(before!==state.trash.length && session) recordAudit('TRASH_AUTO_PURGE',`${before-state.trash.length} elemento(s) vencidos fueron eliminados de la papelera.`);
  }
  function passwordHash(password,salt){ return crypto.subtle.digest('SHA-256',new TextEncoder().encode(salt+'::'+password)).then(buf=>Array.from(new Uint8Array(buf)).map(x=>x.toString(16).padStart(2,'0')).join('')); }
  function simpleHash(password,salt){ let h=2166136261; for(const c of salt+'::'+password){h^=c.charCodeAt(0);h=Math.imul(h,16777619)} return (h>>>0).toString(16); }
  async function hashPass(p,s){ try{return await passwordHash(p,s)}catch(e){return simpleHash(p,s)} }

  function render(){ purgeTrash(); if(!session||!currentAccount()) return renderLogin(); renderPanel(); touchSession(); }
  function renderLogin(register=false){
    $('#app').innerHTML=`<div class="login-screen"><div class="login-card">
      <div class="login-brand"><div><div class="brand-name">Panel inmobiliario</div><div class="brand-sub">Gestión de propiedades y alquileres</div></div></div>
      <h1>${register?'Crear cuenta de inmobiliaria':'Ingresar al panel'}</h1><div id="loginError" class="login-error"></div>
      ${register?`<div class="form-group"><label>Nombre de la inmobiliaria *</label><input id="regInmo" placeholder="Ej. Mi Inmobiliaria"></div>
      <div class="form-group"><label>Nombre del usuario *</label><input id="regName" placeholder="Nombre y apellido"></div>
      <div class="form-group"><label>Email *</label><input id="regEmail" type="email" placeholder="correo@ejemplo.com"></div>
      <div class="form-group"><label>Contraseña *</label><input id="regPass" type="password" placeholder="Mínimo 12 caracteres" oninput="window.passMeter()"><div class="password-meter"><span id="meter"></span></div></div>
      <div class="form-group"><label>Repetir contraseña *</label><input id="regPass2" type="password"></div>
      <button class="btn btn-primary" style="width:100%" onclick="window.register()">Crear cuenta</button>
      <div class="login-hint">¿Ya tenés cuenta? <button class="login-switch" onclick="window.showLogin()">Ingresar</button></div>`:
      `<div class="form-group"><label>Email</label><input id="loginId" type="email" placeholder="correo@ejemplo.com"></div>
      <div class="form-group"><label>Contraseña</label><input id="loginPass" type="password" onkeydown="if(event.key==='Enter')window.login()"></div>
      <button class="btn btn-primary" style="width:100%" onclick="window.login()">Ingresar</button>
      <div class="login-hint">¿Primera vez? <button class="login-switch" onclick="window.showRegister()">Crear cuenta de inmobiliaria</button></div>`}
    </div></div>`;
  }
  window.showRegister=()=>renderLogin(true); window.showLogin=()=>renderLogin(false);
  window.passMeter=()=>{const p=$('#regPass')?.value||'',m=$('#meter');if(!m)return;const score=(p.length>=8)+(p.length>=12)+(/[A-Z]/.test(p))+(/[0-9]/.test(p))+(/[^\w]/.test(p));m.style.width=score*20+'%';m.style.background=score>=4?'var(--olive)':score>=2?'#B77B20':'var(--danger)';};
  window.register=async()=>{
    const inmo=$('#regInmo').value.trim(),name=$('#regName').value.trim(),email=$('#regEmail').value.trim().toLowerCase(),p=$('#regPass').value,p2=$('#regPass2').value,err=$('#loginError');
    if(!inmo||!name||!email||!p){err.textContent='Completá todos los campos.';err.classList.add('show');return;}
    if(p.length<12){err.textContent='La contraseña debe tener al menos 12 caracteres.';err.classList.add('show');return;}
    if(p!==p2){err.textContent='Las contraseñas no coinciden.';err.classList.add('show');return;}
    try{await api('/api/auth/register',{method:'POST',body:JSON.stringify({organization:inmo,name,email,password:p})});window.showVerification(email);}
    catch(e){err.textContent=e.message;err.classList.add('show');}
  };
  window.showVerification=email=>{
    $('#app').innerHTML=`<div class="login-screen"><div class="login-card"><h1>Verificá tu correo</h1><p>Ingresá el código de seis dígitos enviado a ${esc(email)}. Vence en 10 minutos.</p><div id="loginError" class="login-error"></div><div class="form-group"><label>Código de verificación</label><input id="verifyCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div><button class="btn btn-primary" style="width:100%" onclick="window.verifyAccount('${esc(email)}')">Verificar cuenta</button><div class="login-hint"><button class="login-switch" onclick="window.showLogin()">Volver a ingresar</button></div></div></div>`;
  };
  window.verifyAccount=async email=>{try{await api('/api/auth/verify',{method:'POST',body:JSON.stringify({email,code:$('#verifyCode').value.trim()})});alert('Correo verificado. Ya podés iniciar sesión.');renderLogin(false);}catch(e){const el=$('#loginError');el.textContent=e.message;el.classList.add('show');}};
  window.login=async()=>{
    const email=$('#loginId').value.trim().toLowerCase(),password=$('#loginPass').value,err=$('#loginError');
    try{await api('/api/auth/login',{method:'POST',body:JSON.stringify({email,password})});await fetchRemote();bootReady=true;view='properties';render();}
    catch(e){err.textContent=e.message;err.classList.add('show');}
  };
  window.logout=async()=>{bootReady=false;try{await saveQueue;await api('/api/auth/logout',{method:'POST'});}catch(e){console.error(e);}session=null;state=defaultState();clearTimeout(inactivityTimer);renderLogin(false);};
  function touchSession(){if(!session)return;session.lastActivity=Date.now();saveSession();clearTimeout(inactivityTimer);inactivityTimer=setTimeout(()=>{if(session){recordAudit('SESSION_TIMEOUT','Sesión cerrada por inactividad','warning');session=null;saveSession();renderLogin();}},SESSION_MS);}
  ['click','keydown','mousemove'].forEach(ev=>document.addEventListener(ev,()=>{if(session)touchSession()},{passive:true}));

  function renderPanel(){
    const a=currentAccount(),props=accountProperties();
    const titles={properties:'Propiedades',contracts:'Contratos',rentals:'Alquileres',payments:'Pagos',finance:'Liquidación inmobiliaria',security:'Seguridad',audit:'Registro de actividad'};
    $('#app').innerHTML=`<header class="site"><div class="app"><div class="header-row"><div class="brand"><div><div class="brand-name">${esc(a.inmobiliaria)}</div><div class="brand-sub">Gestión inmobiliaria</div></div></div><div class="user-box"><div class="u-name"><strong>${esc(a.userName)}</strong><small>${esc(a.email)}</small></div><button class="btn btn-small" onclick="window.logout()">Salir</button><div class="header-menu"><button class="menu-button" aria-label="Actividades" title="Actividades" onclick="window.go('audit')"><span></span><span></span><span></span></button></div></div></div>
    <nav class="subnav">${nav('properties','Propiedades')}${nav('rentals','Alquileres')}${nav('finance','Liquidaciones')}${nav('payments','Pagos')}${nav('contracts','Contratos')}${nav('security','Seguridad')}</nav></div></header><main class="app">${viewContent(titles[view]||'Propiedades',props)}</main><div id="toast" class="toast"></div>`;
  }
  function nav(v,label){return `<button class="${view===v?'active':''}" onclick="window.go('${v}')">${label}</button>`;}
  window.go=v=>{const previous=view;view=v;try{renderPanel();}catch(err){view=previous;try{renderPanel();}catch(_){/* keep existing DOM if a render fails */}try{recordAudit('SYSTEM_ERROR',`Error al cambiar de pestaña: ${err?.message||err}`,'error');}catch(_){}}};
  function viewContent(title,props){
    if(view==='properties')return propertiesView(props,title);
    if(view==='contracts')return contractsView(title);
    if(view==='rentals')return rentalsView(title);
    if(view==='payments')return paymentsView(title);
    if(view==='finance')return financeView(title);
    if(view==='security')return securityView(title);
    if(view==='audit')return auditView(title);
    return propertiesView(props,'Propiedades');
  }

  function monthPaymentsFor(p, period=periodKey(new Date())){
    return accountPayments().filter(pg=>pg.propertyId===p.id && String(pg.periodo||'')===period);
  }
  function collectionInfo(p, refDate=new Date()){
    if(p.status!=='Alquilado') return {key:'na',label:'No aplica',detail:p.status===SALE_STATUS?'El inmueble está en venta.':'El inmueble no está alquilado.',paid:0,debt:0,pays:[]};
    if(!p.rentDueDay) return {key:'missing',label:'Configurar cobro',detail:'Falta definir el día mensual de cobro.',paid:0,debt:Number(p.rent)||0,pays:[]};
    const now=new Date(refDate), period=periodKey(now), due=Math.min(Math.max(1,Number(p.rentDueDay)),new Date(now.getFullYear(),now.getMonth()+1,0).getDate());
    const tol=Math.max(0,Number(p.rentToleranceDays)||0), ext=Math.min(new Date(now.getFullYear(),now.getMonth()+1,0).getDate(),due+tol);
    const pays=monthPaymentsFor(p,period), paid=pays.reduce((sum,x)=>sum+(Number(x.monto)||0),0), rent=Math.max(0,Number(p.rent)||0), debt=Math.max(0,rent-paid);
    const paidDates=pays.map(x=>new Date((x.fecha||x.createdAt||'')+'T12:00:00')).filter(d=>!Number.isNaN(d.getTime()));
    const lastPaid=paidDates.length?new Date(Math.max(...paidDates.map(d=>d.getTime()))):null, day=now.getDate();
    if(p.contractStartDate){const start=new Date(p.contractStartDate+'T12:00:00');if(!Number.isNaN(start.getTime())&&start>now)return {key:'upcoming',label:'Contrato no iniciado',detail:`Inicia el ${formatDate(p.contractStartDate)}.`,paid,debt,due,tol,ext,pays,lastPaid};}

    // Regla simple de cobro: antes de la fecha programada no se marca atraso.
    // Si se registra un pago antes del vencimiento, se muestra como cobrado/registrado
    // sin adelantar el estado de vencimiento. El estado de falta de pago aparece recién
    // después de la fecha programada y sólo si queda saldo pendiente.
    if(day<due){
      if(paid>0) return {key:'paid-pending',label:'Cobro registrado',detail:`Registrado ${formatDatePayment(lastPaid)} · ${money(paid)}. Vence el día ${due}.`,paid,debt,due,tol,ext,pays,lastPaid};
      return {key:'upcoming',label:`Próximo cobro · día ${due}`,detail:`Vence el día ${due}.`,paid,debt,due,tol,ext,pays,lastPaid};
    }
    if(day===due){
      if(rent>0 && paid>=rent) return {key:'paid',label:'Cobrado',detail:`Cobrado ${formatDatePayment(lastPaid)} · ${money(paid)}.`,paid,debt:0,due,tol,ext,pays,lastPaid};
      return {key:'due',label:paid>0?'Pago parcial · vence hoy':'Vence hoy',detail:`Vencimiento mensual: día ${due}. ${debt?`Saldo pendiente ${money(debt)}.`:'Cobrado.'}`,paid,debt,due,tol,ext,pays,lastPaid};
    }
    // Después del vencimiento, la deuda pasa a estado de falta de pago.
    if(rent>0 && paid>=rent) return {key:'paid',label:'Cobrado',detail:`Cobrado ${formatDatePayment(lastPaid)} · ${money(paid)}.`,paid,debt:0,due,tol,ext,pays,lastPaid};
    if(day<=ext && tol>0) return {key:'late',label:'Falta de pago',detail:`Vencido el día ${due}. Saldo pendiente ${money(debt)}.`,paid,debt,due,tol,ext,pays,lastPaid};
    return {key:'late',label:'Falta de pago',detail:`La fecha de cobro pasó el día ${due}. Saldo pendiente ${money(debt)}.`,paid,debt,due,tol,ext,pays,lastPaid};
  }
  function formatDatePayment(d){return d?d.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit',year:'numeric'}):'—';}
  function calendarData(p, year, month){
    const today=new Date(), firstOfMonth=new Date(year,month,1), ref=(year===today.getFullYear()&&month===today.getMonth())?today:(firstOfMonth>today?firstOfMonth:new Date(year,month+1,0)), info=collectionInfo(p,ref), first=new Date(year,month,1), days=new Date(year,month+1,0).getDate(), start=(first.getDay()+6)%7, names=['L','M','X','J','V','S','D'];
    const pays=monthPaymentsFor(p,`${year}-${String(month+1).padStart(2,'0')}`), paidDays=new Set(pays.map(x=>{const d=new Date((x.fecha||x.createdAt||'')+'T12:00:00');return Number.isNaN(d.getTime())?0:d.getDate();}));
    let cells=names.map(n=>`<span class="cal-head">${n}</span>`).join(''); for(let i=0;i<start;i++)cells+='<span class="cal-empty"></span>';
    for(let d=1;d<=days;d++){const cls=['cal-day'];if(d===new Date().getDate()&&month===new Date().getMonth()&&year===new Date().getFullYear())cls.push('today');if(d===info.due)cls.push('due');if(info.tol>0&&d>info.due&&d<=info.ext)cls.push('extension');if(paidDays.has(d))cls.push('paid');cells+=`<span class="${cls.join(' ')}">${d}</span>`;}
    const total=pays.reduce((a,x)=>a+(Number(x.monto)||0),0), debt=Math.max(0,(Number(p.rent)||0)-total), months=['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const paymentRows=pays.length?pays.map(x=>`<div class="cal-payment"><span>${formatDatePayment(new Date((x.fecha||x.createdAt||'')+'T12:00:00'))}</span><strong>${money(x.monto)}</strong><small>${esc(x.metodo||'Sin método')} · ${esc(x.periodo||'')}</small></div>`).join(''):'<div class="cal-no-payments">No hay cobros registrados en este período.</div>';
    return `<div class="collection-calendar" data-property-calendar="${esc(p.id)}"><div class="cal-title"><div><strong>${months[month]} ${year}</strong><span>${esc(info.label)}</span></div><div class="cal-nav"><select aria-label="Mes" onchange="window.changePropertyCalendarModal('${p.id}',this.value)">${months.map((m,i)=>`<option value="${year}-${i+1}" ${i===month?'selected':''}>${m}</option>`).join('')}</select><select aria-label="Año" onchange="window.changePropertyCalendarModal('${p.id}',this.value)">${Array.from({length:21},(_,i)=>year-10+i).map(y=>`<option value="${y}-${month+1}" ${y===year?'selected':''}>${y}</option>`).join('')}</select></div></div><div class="cal-grid">${cells}</div><div class="cal-legend"><span><i class="dot dot-due"></i>Vencimiento día ${info.due||'—'}</span>${info.tol?`<span><i class="dot dot-extension"></i>Extensión hasta día ${info.ext}</span>`:''}<span><i class="dot dot-paid"></i>Días con cobros registrados</span></div><div class="cal-summary"><div><span>Alquiler</span><strong>${money(p.rent)}</strong></div><div><span>Cobrado</span><strong class="cal-paid-total">${money(total)}</strong></div><div><span>Saldo</span><strong class="${debt?'debt':'paid-text'}">${debt?money(debt):'Sin deuda'}</strong></div></div><div class="cal-payments"><div class="cal-section-title">Detalle exacto de cobros</div>${paymentRows}</div></div>`;
  }
  function calendarMonthHtml(p){
    const info=collectionInfo(p), now=new Date();
    return `<button type="button" class="collection-calendar-btn" onclick="window.openPropertyCalendar('${p.id}')" aria-label="Abrir calendario de cobro">▣ Calendario</button>`;
  }
  function calendarModalHtml(p, year=new Date().getFullYear(), month=new Date().getMonth()){
    return calendarData(p,year,month).replace('class="collection-calendar"','class="collection-calendar collection-calendar-modal"');
  }

  // Calendario de cobro: se abre siempre en una ventana flotante fuera de la tabla.
  window.openPropertyCalendar=(id, year=new Date().getFullYear(), month=new Date().getMonth())=>{
    const p=state.properties.find(x=>x.id===id&&x.accountId===accountId());
    if(!p){toast('Propiedad no encontrada.');return;}
    document.querySelectorAll('.overlay').forEach(el=>el.remove());
    document.body.insertAdjacentHTML('beforeend',`<div class="overlay open calendar-overlay" id="modal" data-calendar-property="${esc(id)}">
      <div class="calendar-modal-drawer" role="dialog" aria-modal="true" aria-label="Calendario de cobro">
        <button class="close" type="button" onclick="window.closeModal()" aria-label="Cerrar">×</button>
        <h3>Calendario de cobro</h3>
        <p class="calendar-modal-sub"><strong>${esc(p.title)}</strong>${p.address?` · ${esc(p.address)}`:''}</p>
        <div id="propertyCalendarContent">${calendarModalHtml(p,year,month)}</div>
      </div>
    </div>`);
  };
  window.openPropertyCalendar=window.openPropertyCalendar;
  window.changePropertyCalendarModal=(id,value)=>{
    const parts=String(value||'').split('-').map(Number), year=parts[0], month=(parts[1]||1)-1;
    if(!Number.isFinite(year)||!Number.isFinite(month))return;
    const p=state.properties.find(x=>x.id===id&&x.accountId===accountId());
    const box=$('#propertyCalendarContent');
    if(p&&box)box.innerHTML=calendarModalHtml(p,year,month);
  };

  function propertyRow(p){
    const c=propertyContract(p), ps=collectionInfo(p), isSale=p.status===SALE_STATUS;
    const glow=ps.paid>0?'paid-glow':(ps.debt>0&&ps.key==='late'?'due-glow':''); return `<tr class="${glow}"><td class="check-cell"><input class="property-check" type="checkbox" value="${esc(p.id)}" onchange="window.togglePropertySelection('${p.id}',this.checked)" ${selectedPropertyIds.has(p.id)?'checked':''}></td><td><div class="property-name-line"><span class="collection-light ${glow}" title="${glow==='paid-glow'?'Cobro registrado':glow==='due-glow'?'Falta de pago / vencimiento':'Estado de cobro'}"></span><strong>${esc(p.title)}</strong><button class="contract-mini-btn ${c?'has-contract':''}" title="${c?'Abrir contrato':'Subir o crear contrato'}" onclick="window.openPropertyContract('${p.id}')">Contrato</button></div><span class="muted property-address">${esc(p.address||'Sin dirección')} · <span class="type-chip">${esc(p.type||'Otro')}</span></span></td><td><span class="pill pill-${esc(statusClass(p.status))}">${esc(p.status)}</span></td><td>${isSale?'—':money(p.rent)}</td><td><div class="collection-cell"><span class="payment-status status-${ps.key}">${esc(ps.label)}</span><span class="collection-info-line">${ps.debt>0?`Debe ${money(ps.debt)}`:esc(ps.detail)}</span>${isSale?'':calendarMonthHtml(p)}</div></td><td>${isSale?`<span class="tenant-name">${esc(p.owner||'Sin propietario')}</span><span class="muted property-address">Propietario</span>`:`<span class="tenant-name">${esc(p.tenant||'Sin inquilino')}</span>`}</td><td><div class="row-actions"><button class="btn btn-small" onclick="window.editProperty('${p.id}')">Editar</button><button class="btn btn-small btn-payment" onclick="window.openPropertyPayment('${p.id}')">Pago</button><button class="btn btn-small icon-action icon-download" aria-label="Descargar Excel" title="Descargar Excel" onclick="window.exportPropertyExcel('${p.id}')">↓</button><button class="btn btn-small btn-danger icon-action icon-trash" aria-label="Enviar a papelera" title="Enviar a papelera" onclick="window.deleteProperty('${p.id}')">🗑</button></div></td></tr>`;
  }
  // Prioridad para ordenar por "Cobro": lo más urgente primero cuando el orden es ascendente.
  const COLLECTION_SORT_PRIORITY={late:5,due:4,'paid-pending':3,missing:2,upcoming:1,paid:0,na:-1};
  function filterAndSortProperties(props){
    let list=props.slice();
    const q=propertyFilters.search.trim().toLowerCase();
    if(q) list=list.filter(p=>[p.title,p.address,p.tenant,p.owner].some(v=>String(v||'').toLowerCase().includes(q)));
    if(propertyFilters.status) list=list.filter(p=>p.status===propertyFilters.status);
    if(propertyFilters.type) list=list.filter(p=>p.type===propertyFilters.type);
    if(propertyFilters.sortKey){
      const dir=propertyFilters.sortDir==='desc'?-1:1;
      list.sort((a,b)=>{
        let av,bv;
        if(propertyFilters.sortKey==='rent'){ av=Number(a.rent)||0; bv=Number(b.rent)||0; }
        else { av=COLLECTION_SORT_PRIORITY[collectionInfo(a).key]??0; bv=COLLECTION_SORT_PRIORITY[collectionInfo(b).key]??0; }
        return (av-bv)*dir;
      });
    }
    return list;
  }
  function sortArrow(key){ if(propertyFilters.sortKey!==key) return ''; return propertyFilters.sortDir==='asc'?' ▲':' ▼'; }
  window.sortPropertiesBy=key=>{
    if(propertyFilters.sortKey===key) propertyFilters.sortDir=propertyFilters.sortDir==='asc'?'desc':'asc';
    else { propertyFilters.sortKey=key; propertyFilters.sortDir='asc'; }
    renderPropertiesTableRegion();
  };
  window.applyPropertyFilters=()=>{
    propertyFilters.search=$('#propSearch')?.value||'';
    propertyFilters.status=$('#propFilterStatus')?.value||'';
    propertyFilters.type=$('#propFilterType')?.value||'';
    renderPropertiesTableRegion();
  };
  // Vuelve a pintar sólo la tabla (no el buscador/filtros), para no perder el foco mientras se tipea.
  function renderPropertiesTableRegion(){
    const region=$('#propertiesTableRegion'); if(!region) return;
    region.innerHTML=propertiesTableRegionHtml(accountProperties());
  }
  function propertiesTableRegionHtml(allProps){
    const filtered=filterAndSortProperties(allProps);
    const selected=allProps.filter(p=>selectedPropertyIds.has(p.id));
    const bulk=selected.length?`<div class="bulk-toolbar"><strong>${selected.length} propiedad(es) seleccionada(s)</strong><div class="actions"><button class="btn" onclick="window.exportSelectedPropertiesExcel()">Descargar seleccionadas</button><button class="btn btn-danger" onclick="window.deleteSelectedProperties()">Enviar a papelera</button><button class="btn btn-small" onclick="window.clearPropertySelection()">Limpiar selección</button></div></div>`:'';
    if(!allProps.length) return bulk+'<div class="empty"><strong>No hay propiedades</strong><p>Agregá la primera propiedad para comenzar.</p></div>';
    if(!filtered.length) return bulk+'<div class="empty"><strong>Sin resultados</strong><p>No hay propiedades que coincidan con la búsqueda o los filtros.</p></div>';
    const allChecked=filtered.every(p=>selectedPropertyIds.has(p.id));
    const rentSort=propertyFilters.sortKey==='rent'?(propertyFilters.sortDir==='asc'?'ascending':'descending'):'none';
    const cobroSort=propertyFilters.sortKey==='cobro'?(propertyFilters.sortDir==='asc'?'ascending':'descending'):'none';
    return `${bulk}<div class="table-wrap property-table-wrap"><table class="admin"><thead><tr><th class="check-cell"><input type="checkbox" aria-label="Seleccionar todas" onchange="window.toggleAllProperties(this.checked)" ${allChecked?'checked':''}></th><th>Propiedad</th><th>Estado</th><th class="sortable" tabindex="0" role="button" aria-sort="${rentSort}" onclick="window.sortPropertiesBy('rent')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.sortPropertiesBy('rent')}">Alquiler${sortArrow('rent')}</th><th class="sortable" tabindex="0" role="button" aria-sort="${cobroSort}" onclick="window.sortPropertiesBy('cobro')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.sortPropertiesBy('cobro')}">Cobro${sortArrow('cobro')}</th><th>Inquilino</th><th></th></tr></thead><tbody>${filtered.map(propertyRow).join('')}</tbody></table></div>`;
  }
  function propertiesView(props,title){
    const rented=props.filter(p=>p.status==='Alquilado').length,monthly=props.reduce((s,p)=>s+(Number(p.rent)||0),0),available=props.filter(p=>p.status==='Disponible').length,forSale=props.filter(p=>p.status===SALE_STATUS).length;
    const statusOptions=PROPERTY_STATUS.map(s=>`<option value="${esc(s)}" ${propertyFilters.status===s?'selected':''}>${esc(s)}</option>`).join('');
    const typeOptions=PROPERTY_TYPES.map(t=>`<option value="${esc(t)}" ${propertyFilters.type===t?'selected':''}>${esc(t)}</option>`).join('');
    return `<div class="admin-head"><h2>${title}</h2><div class="actions"><button class="btn btn-primary" onclick="window.openProperty()">+ Agregar propiedad</button><button class="btn" onclick="window.withBusyButton(this,'Exportando…',window.exportAllExcel)">Exportar Excel</button><button class="btn" onclick="window.openImport()">Importar Excel</button></div></div>
    <div class="stat-row"><div class="stat"><div class="s-label">Propiedades</div><div class="s-val">${props.length}</div></div><div class="stat"><div class="s-label">Alquiladas</div><div class="s-val">${rented}</div></div><div class="stat"><div class="s-label">Disponibles</div><div class="s-val">${available}</div></div><div class="stat"><div class="s-label">En venta</div><div class="s-val">${forSale}</div></div><div class="stat"><div class="s-label">Alquiler mensual</div><div class="s-val">${money(monthly)}</div></div></div>
    <div class="panel"><div class="panel-head"><h3>Gestión de propiedades</h3><span class="muted">Buscá, filtrá y ordená tu cartera</span></div>
    <div class="property-filters"><input id="propSearch" type="search" placeholder="Buscar por nombre, dirección o inquilino…" value="${esc(propertyFilters.search)}" oninput="window.applyPropertyFilters()" aria-label="Buscar propiedades"><select id="propFilterStatus" onchange="window.applyPropertyFilters()" aria-label="Filtrar por estado"><option value="">Todos los estados</option>${statusOptions}</select><select id="propFilterType" onchange="window.applyPropertyFilters()" aria-label="Filtrar por tipo"><option value="">Todos los tipos</option>${typeOptions}</select></div>
    <div id="propertiesTableRegion">${propertiesTableRegionHtml(props)}</div></div>`;
  }

  function propertyModal(p={}){
    $('#modal')?.remove();
    const opts=PROPERTY_TYPES.map(t=>`<option value="${esc(t)}" ${p.type===t?'selected':''}>${esc(t)}</option>`).join('');
    const sale=p.status===SALE_STATUS;
    const stats=PROPERTY_STATUS.map(t=>`<option value="${esc(t)}" ${p.status===t||(!p.status&&t==='Disponible')?'selected':''}>${esc(t)}</option>`).join('');
    document.body.insertAdjacentHTML('beforeend',`<div class="overlay open" id="modal"><div class="drawer" role="dialog" aria-modal="true" aria-label="${p.id?'Editar propiedad':'Nueva propiedad'}"><button class="close" onclick="window.closeModal()">×</button><h3>${p.id?'Editar propiedad':'Nueva propiedad'}</h3>
    <div class="form-group"><label>Nombre / identificación *</label><input id="pTitle" value="${esc(p.title||'')}" autofocus></div>
    <div class="form-group"><label>Dirección</label><input id="pAddress" value="${esc(p.address||'')}"></div>
    <div class="form-row"><div class="form-group"><label>Tipo de inmueble *</label><select id="pType">${opts}</select></div><div class="form-group"><label>Estado *</label><select id="pStatus" onchange="window.togglePropertyStatusFields()">${stats}</select></div></div>
    <div class="form-group" data-rental-only ${sale?'hidden':''}><label>Alquiler mensual</label><input id="pRent" type="number" min="0" step="1" value="${Number(p.rent)||0}"></div>
    <div id="pOwnerSection" data-new="${p.id?'':'1'}" ${p.id&&!sale?'hidden':''}><div class="section-kicker">${!p.id?'Agregar propietario':'Propietario'}</div>
    <div class="form-row"><div class="form-group"><label>Nombre y apellido</label><input id="pOwner" value="${esc(p.owner||'')}" placeholder="Nombre y apellido"></div><div class="form-group"><label>Teléfono</label><input id="pOwnerPhone" type="tel" value="${esc(p.ownerPhone||'')}" placeholder="Ej. 3462 55-0192"></div></div>
    <div class="form-group"><label>Email</label><input id="pOwnerEmail" type="email" value="${esc(p.ownerEmail||'')}" placeholder="correo@ejemplo.com"></div></div>
    <div data-rental-only ${sale?'hidden':''}><div class="section-kicker">${!p.id?'Agregar inquilino':'Inquilino'}</div>
    <div class="form-row"><div class="form-group"><label>Nombre y apellido</label><input id="pTenant" value="${esc(p.tenant||'')}"></div><div class="form-group"><label>Teléfono</label><input id="pTenantPhone" type="tel" value="${esc(p.tenantPhone||'')}" placeholder="Ej. 3462 55-0192"></div></div>
    <div class="form-group"><label>Email</label><input id="pTenantEmail" type="email" value="${esc(p.tenantEmail||'')}"></div></div>
    <div class="contract-data-box" data-rental-only ${sale?'hidden':''}><div class="section-kicker">Control del alquiler</div><div class="form-row"><div class="form-group"><label>Inicio del contrato</label><input id="pContractStart" type="date" value="${esc(p.contractStartDate||'')}"></div><div class="form-group"><label>Día de cobro mensual</label><input id="pRentDueDay" type="number" min="1" max="31" value="${p.rentDueDay?esc(p.rentDueDay):''}" placeholder="Ej. 5"></div></div><div class="form-row"><div class="form-group"><label>Días de tolerancia</label><input id="pRentTolerance" type="number" min="0" max="31" value="${Number.isFinite(Number(p.rentToleranceDays))?esc(p.rentToleranceDays):5}"></div><div class="form-group"><label>Estado de cobro</label><div class="payment-status-preview">${esc(collectionInfo(p).label)}</div></div></div><div class="muted">El sistema compara el día de cobro, la tolerancia y los pagos registrados del mes actual.</div></div>
    <div class="contract-data-box"><div class="section-kicker">Expensas ordinarias (importes variables; se cargan al generar cada comprobante)</div><div id="pExpOrdinary" class="expense-check-grid">${EXPENSES_ORDINARY.map(it=>`<label class="expense-check"><input type="checkbox" value="${it.key}" ${(p.expensesOrdinary||[]).includes(it.key)?'checked':''}> ${esc(it.label)}</label>`).join('')}</div></div>
    <div class="contract-data-box"><div class="section-kicker">Expensas extraordinarias (a cargo del propietario; importes variables)</div><div id="pExpExtra" class="expense-check-grid">${EXPENSES_EXTRAORDINARY.map(it=>`<label class="expense-check"><input type="checkbox" value="${it.key}" ${(p.expensesExtraordinary||[]).includes(it.key)?'checked':''}> ${esc(it.label)}</label>`).join('')}</div></div>
    <div class="form-group"><label>Notas</label><textarea id="pNotes" rows="4">${esc(p.notes||'')}</textarea></div>
    <div class="form-actions"><button class="btn btn-primary" onclick="window.saveProperty('${p.id||''}')">Guardar propiedad</button><button class="btn" onclick="window.closeModal()">Cancelar</button></div></div></div>`);
  }
  // En venta: se oculta todo lo propio del alquiler (inquilino, monto y control de cobro) y se muestra el propietario.
  window.togglePropertyStatusFields=()=>{
    const sale=$('#pStatus')?.value===SALE_STATUS;
    document.querySelectorAll('#modal [data-rental-only]').forEach(el=>{el.hidden=sale;});
    const owner=$('#pOwnerSection'); if(owner) owner.hidden=!(sale||owner.dataset.new==='1');
  };
  window.openProperty=()=>propertyModal();
  window.editProperty=id=>{const p=state.properties.find(x=>x.id===id&&x.accountId===accountId());if(p)propertyModal(p);};
  window.closeModal=()=>{document.querySelectorAll('.overlay').forEach(el=>el.remove());currentReceiptId=null;};
  window.saveProperty=id=>{
    const a=currentAccount(),old=state.properties.find(p=>p.id===id&&p.accountId===a.id),title=$('#pTitle').value.trim(),status=$('#pStatus').value,sale=status===SALE_STATUS;
    const data={id:id||uid('prop'),accountId:a.id,title,address:$('#pAddress').value.trim(),type:$('#pType').value,status,rent:sale?0:Math.max(0,Number($('#pRent').value)||0),owner:$('#pOwner')?.value.trim()||'',ownerPhone:$('#pOwnerPhone')?.value.trim()||'',ownerEmail:$('#pOwnerEmail')?.value.trim()||'',tenant:sale?'':$('#pTenant').value.trim(),tenantPhone:sale?'':($('#pTenantPhone')?.value.trim()||''),tenantEmail:sale?'':$('#pTenantEmail').value.trim(),notes:$('#pNotes').value.trim(),contractStartDate:sale?'':($('#pContractStart')?.value||''),rentDueDay:sale?null:(Math.min(31,Math.max(0,Number($('#pRentDueDay')?.value)||0))||null),rentToleranceDays:Math.min(31,Math.max(0,Number($('#pRentTolerance')?.value)||0)),expensesOrdinary:[...document.querySelectorAll('#pExpOrdinary input:checked')].map(i=>i.value),expensesExtraordinary:[...document.querySelectorAll('#pExpExtra input:checked')].map(i=>i.value),updatedAt:new Date().toISOString(),createdAt:old?.createdAt||new Date().toISOString()};
    if(!title){toast('El nombre de la propiedad es obligatorio.');$('#pTitle')?.focus();return;}
    if(old){snapshot('Backup previo a edición');Object.assign(old,data);recordAudit('PROPERTY_UPDATE',`Actualizada propiedad ${title}`);}else{snapshot('Backup previo a alta');state.properties.push(data);recordAudit('PROPERTY_CREATE',`Creada propiedad ${title}`);}
    saveState();closeModal();toast('Propiedad guardada correctamente.');renderPanel();
  };
  window.togglePropertySelection=(id,checked)=>{if(checked)selectedPropertyIds.add(id);else selectedPropertyIds.delete(id);renderPropertiesTableRegion();};
  window.toggleAllProperties=checked=>{filterAndSortProperties(accountProperties()).forEach(p=>checked?selectedPropertyIds.add(p.id):selectedPropertyIds.delete(p.id));renderPropertiesTableRegion();};
  window.clearPropertySelection=()=>{selectedPropertyIds.clear();renderPropertiesTableRegion();};
  window.deleteProperty=id=>{
    const p=state.properties.find(x=>x.id===id&&x.accountId===accountId());if(!p)return;
    if(!confirm(`Enviar "${p.title}" a la papelera? Se podrá restaurar durante ${TRASH_DAYS} días.`))return;
    snapshot('Backup previo a eliminación');
    const linkedContracts=state.contracts.filter(c=>c.propertyId===p.id&&c.accountId===accountId());
    const trashEntry={id:uid('trash'),accountId:p.accountId,deletedAt:new Date().toISOString(),snapshot:JSON.parse(JSON.stringify(p)),linkedContracts:JSON.parse(JSON.stringify(linkedContracts))};
    state.trash.unshift(trashEntry);
    state.properties=state.properties.filter(x=>x.id!==id);
    state.contracts=state.contracts.filter(c=>!(c.propertyId===id&&c.accountId===accountId()));
    selectedPropertyIds.delete(id);
    recordAudit('PROPERTY_DELETE',`Propiedad enviada a papelera: ${p.title}`,'warning');
    saveState();
    lastDeletedTrashIds=[trashEntry.id];
    renderPanel();
    toast('Propiedad enviada a papelera.',{actionLabel:'Deshacer',onAction:window.undoLastDelete,duration:6000});
  };
  window.deleteSelectedProperties=()=>{
    const ids=[...selectedPropertyIds].filter(id=>state.properties.some(p=>p.id===id&&p.accountId===accountId()));
    if(!ids.length){toast('No hay propiedades seleccionadas.');return;}
    if(!confirm(`Enviar ${ids.length} propiedad(es) a la papelera? Se podrán restaurar durante ${TRASH_DAYS} días.`))return;
    snapshot('Backup previo a eliminación múltiple');
    const now=new Date().toISOString();
    const selected=state.properties.filter(p=>ids.includes(p.id)&&p.accountId===accountId());
    const trashIds=[];
    selected.forEach(p=>{
      const linkedContracts=state.contracts.filter(c=>c.propertyId===p.id&&c.accountId===accountId());
      const trashEntry={id:uid('trash'),accountId:p.accountId,deletedAt:now,snapshot:JSON.parse(JSON.stringify(p)),linkedContracts:JSON.parse(JSON.stringify(linkedContracts))};
      state.trash.unshift(trashEntry); trashIds.push(trashEntry.id);
    });
    state.properties=state.properties.filter(p=>!ids.includes(p.id)||p.accountId!==accountId());
    state.contracts=state.contracts.filter(c=>!ids.includes(c.propertyId)||c.accountId!==accountId());
    ids.forEach(id=>selectedPropertyIds.delete(id));
    recordAudit('PROPERTY_DELETE_BULK',`${ids.length} propiedad(es) enviada(s) a papelera.`,'warning');
    saveState();
    lastDeletedTrashIds=trashIds;
    renderPanel();
    toast(`${ids.length} propiedad(es) enviada(s) a papelera.`,{actionLabel:'Deshacer',onAction:window.undoLastDelete,duration:6000});
  };
  window.undoLastDelete=()=>{
    const ids=lastDeletedTrashIds.slice(); lastDeletedTrashIds=[];
    if(!ids.length) return;
    ids.forEach(id=>window.restoreTrash(id,true));
    renderPanel();
    toast(ids.length>1?`${ids.length} propiedades restauradas.`:'Propiedad restaurada.');
  };

  function formatDate(v){const d=new Date(v+'T12:00:00');return Number.isNaN(d.getTime())?'—':d.toLocaleDateString('es-AR');}
  function contractFileToDataUrl(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});}
  function contractById(id){return state.contracts.find(c=>c.id===id&&c.accountId===accountId());}
  function contractProperty(c){return state.properties.find(p=>p.id===c.propertyId&&p.accountId===accountId());}
  function editorFocus(){ const ed=$('#contractEditor'); if(ed)ed.focus(); return ed; }
  window.execEditor=(command,value=null)=>{ const ed=editorFocus(); if(!ed)return; try{document.execCommand(command,false,value); window.scheduleContractAutosave?.();}catch(e){toast('No se pudo aplicar el formato.');} };
  window.editorFormatBlock=tag=>window.execEditor('formatBlock',tag);
  window.editorFont=font=>window.execEditor('fontName',font);
  window.editorSize=size=>window.execEditor('fontSize',size);
  window.editorColor=color=>window.execEditor('foreColor',color);
  window.editorHighlight=color=>{ editorFocus(); try{document.execCommand('hiliteColor',false,color); window.scheduleContractAutosave?.();}catch(e){toast('No se pudo aplicar el resaltado.');} };
  window.editorLink=()=>{ editorFocus(); const url=prompt('Ingresá la URL del enlace:','https://'); if(url&&/^https?:\/\//i.test(url))window.execEditor('createLink',url); else if(url)toast('El enlace debe comenzar con http:// o https://'); };
  window.insertContractTable=()=>{ const ed=editorFocus(); if(!ed)return; const html='<table><tbody><tr><td>Campo</td><td>Información</td></tr><tr><td>Dato</td><td>Completar</td></tr></tbody></table><p><br></p>'; try{document.execCommand('insertHTML',false,html);window.scheduleContractAutosave?.();}catch(e){toast('No se pudo insertar la tabla.');} };
  window.openPropertyContract=id=>{
    const p=state.properties.find(x=>x.id===id&&x.accountId===accountId()); if(!p)return;
    let c=propertyContract(p);
    if(!c){
      c={id:uid('contract'),accountId:accountId(),propertyId:p.id,title:`Contrato — ${p.title}`,startDate:p.contractStartDate||'',dueDay:p.rentDueDay||null,contentHtml:'<h2>CONTRATO DE ALQUILER</h2><p>Entre las partes que suscriben el presente contrato...</p><p><br></p>',fileData:'',fileName:'',fileType:'',specialCases:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),active:true};
      state.contracts.push(c); saveState(); recordAudit('CONTRACT_CREATE',`Creado contrato para ${p.title}`);
    }
    activeContractId=c.id;
    openPropertyContractModal(p,c);
  };

  function openPropertyContractModal(p,c){
    $('#modal')?.remove();
    document.body.insertAdjacentHTML('beforeend',`<div class="overlay open" id="modal" data-contract-property="${esc(p.id)}">
      <div class="drawer contract-property-drawer" role="dialog" aria-modal="true" aria-label="Contrato de la propiedad">
        <button class="close" type="button" onclick="window.closeModal()" aria-label="Cerrar">×</button>
        <div class="contract-property-modal-head"><div><div class="section-kicker">Contrato de propiedad</div><h3>${esc(p.title)}</h3><span class="muted">${esc(p.address||'Sin dirección')}</span></div><span class="contract-modal-status">${c.fileName?'Archivo cargado':'Sin archivo cargado'}</span></div>
        <div class="contract-property-filebox">
          <div class="contract-property-file-main"><strong>${c.fileName?esc(c.fileName):'Cargar contrato'}</strong><span>${c.fileName?'El documento queda asociado a esta propiedad.':'Formatos admitidos: PDF o Word (.docx).'}</span></div>
          <input id="propertyContractFile" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onchange="window.attachPropertyContractFile('${p.id}')">
          <button type="button" class="btn btn-primary" onclick="document.getElementById('propertyContractFile')?.click()">${c.fileName?'Reemplazar archivo':'Cargar contrato'}</button>
        </div>
        <div class="contract-property-viewer-wrap">
          ${c.fileName?`<div id="propertyContractViewer" class="contract-property-viewer"><div class="viewer-loading">Cargando visualizador…</div></div>`:`<div class="contract-property-empty"><strong>No hay un documento cargado.</strong><span>Cargá un PDF o Word para visualizarlo sin salir de Gestión de propiedades.</span></div>`}
        </div>
        <div class="contract-cases-box"><div class="section-kicker">Casos especiales (renovaciones / actualizaciones de contrato)</div>
          <div class="case-list">${(c.specialCases||[]).length?(c.specialCases||[]).map(cs=>`<div class="case-item"><div class="case-item-head"><strong>${esc(cs.date||'')}</strong><button type="button" class="btn btn-small btn-danger" onclick="window.deleteSpecialCase('${c.id}','${cs.id}')">Eliminar</button></div><p>${esc(cs.text)}</p></div>`).join(''):'<p class="muted">Sin casos especiales registrados.</p>'}</div>
          <div class="form-row"><div class="form-group"><label>Fecha</label><input id="caseDate" type="date" value="${fmtDateInput()}"></div></div>
          <div class="form-group"><label>Detalle (qué se renovó, actualizó o acordó)</label><textarea id="caseText" rows="3" placeholder="Ej: Renovación por 24 meses con ajuste trimestral por ICL a partir de marzo 2026."></textarea></div>
          <button type="button" class="btn" onclick="window.addSpecialCase('${c.id}')">Agregar caso especial</button>
        </div>
        <div class="form-actions contract-property-modal-actions"><button type="button" class="btn" onclick="window.closeModal()">Cerrar</button>${c.fileName?`<button type="button" class="btn" onclick="window.downloadContractFile('${c.id}')">↓ Descargar</button>`:''}<button type="button" class="btn btn-primary" onclick="window.openContractEditor('${c.id}')">Editar contrato</button></div>
      </div>
    </div>`);
    if(c.fileName)setTimeout(()=>renderPropertyContractViewer(c),0);
  }

  async function renderPropertyContractViewer(c){
    const box=$('#propertyContractViewer'); if(!box||!c?.fileName)return;
    try{
      const data=await ensureContractFileData(c);
      if(!data) throw new Error('El archivo no se pudo recuperar.');
      if(/pdf/i.test(c.fileType)||/\.pdf$/i.test(c.fileName||'')){
        box.innerHTML=`<iframe class="contract-property-pdf" title="${esc(c.fileName||'Contrato PDF')}" src="${data}"></iframe>`;
      }else if(/word|officedocument/i.test(c.fileType)||/\.docx$/i.test(c.fileName||'')){
        if(!window.mammoth)throw new Error('No se pudo cargar el visualizador Word.');
        const res=await mammoth.convertToHtml({arrayBuffer:dataUrlToArrayBuffer(data)});
        box.innerHTML=`<div class="contract-property-docx">${res.value||'<p>El documento Word no contiene texto visible.</p>'}</div>`;
      }else{
        box.innerHTML='<div class="contract-property-empty"><strong>Formato no compatible para vista previa.</strong><span>Podés editarlo desde la sección Contratos.</span></div>';
      }
    }catch(e){
      box.innerHTML=`<div class="contract-property-empty"><strong>No se pudo generar la vista previa.</strong><span>El archivo sigue guardado. Usá “Editar contrato” para abrirlo en Contratos.</span></div>`;
      recordAudit('SYSTEM_ERROR','Error en visualizador de contrato: '+(e.message||e),'error');
    }
  }
  window.addSpecialCase=contractId=>{
    const c=contractById(contractId); if(!c) return;
    const text=$('#caseText')?.value.trim();
    if(!text){toast('Describí qué se hizo en el contrato.');return;}
    const date=$('#caseDate')?.value||fmtDateInput();
    if(!Array.isArray(c.specialCases)) c.specialCases=[];
    c.specialCases.unshift({id:uid('case'),date,text,createdAt:new Date().toISOString()});
    c.updatedAt=new Date().toISOString();
    saveState();
    recordAudit('CONTRACT_SPECIAL_CASE',`Caso especial agregado (${contractProperty(c)?.title||'propiedad'}): ${text.slice(0,80)}`);
    toast('Caso especial agregado.');
    const p=contractProperty(c); if(p) openPropertyContractModal(p,c);
  };
  window.deleteSpecialCase=(contractId,caseId)=>{
    const c=contractById(contractId); if(!c) return;
    if(!confirm('¿Eliminar este caso especial?')) return;
    c.specialCases=(c.specialCases||[]).filter(x=>x.id!==caseId);
    c.updatedAt=new Date().toISOString();
    saveState();
    recordAudit('CONTRACT_SPECIAL_CASE_DELETE',`Caso especial eliminado (${contractProperty(c)?.title||'propiedad'}).`);
    const p=contractProperty(c); if(p) openPropertyContractModal(p,c);
  };
  function dataUrlToArrayBuffer(dataUrl){const b64=String(dataUrl).split(',')[1]||'';const bin=atob(b64);const bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);return bytes.buffer;}
  window.attachPropertyContractFile=async propertyId=>{
    const file=$('#propertyContractFile')?.files?.[0]; if(!file)return;
    if(file.size>4*1024*1024){toast('El archivo supera 4 MB.');$('#propertyContractFile').value='';return;}
    const p=state.properties.find(x=>x.id===propertyId&&x.accountId===accountId()),c=p&&propertyContract(p);if(!p||!c)return;
    try{
      const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error||new Error('No se pudo leer el archivo.'));r.readAsDataURL(file);});
      c.fileData=String(data);c.fileName=file.name;c.fileType=file.type||'';c.updatedAt=new Date().toISOString();
      await idbSetFile(c.id,c.fileData);
      // Convertir el documento a texto editable, igual que al cargarlo desde la pestaña Contratos.
      // Sin este paso, "Editar contrato" mostraba el editor vacío o con el texto de plantilla,
      // porque contentHtml nunca se actualizaba con lo que traía el archivo subido.
      try{
        if(/\.docx$/i.test(file.name)){
          if(window.mammoth){
            const ab=await file.arrayBuffer();
            const result=await mammoth.convertToHtml({arrayBuffer:ab,styleMap:['p[style-name="Title"] => h1:fresh','p[style-name="Heading 1"] => h2:fresh','p[style-name="Heading 2"] => h3:fresh']});
            c.contentHtml=result.value||c.contentHtml;
          }else{
            recordAudit('SYSTEM_ERROR','No se pudo convertir el Word a texto editable: falta el módulo mammoth.','error');
          }
        }else if(/\.pdf$/i.test(file.name)||file.type==='application/pdf'){
          if(!window.pdfjsLib&&window.pdfjsLibPromise)await window.pdfjsLibPromise;
          if(window.pdfjsLib){
            const ab=await file.arrayBuffer(),pdf=await pdfjsLib.getDocument({data:new Uint8Array(ab)}).promise;
            let text='';
            for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i),content=await page.getTextContent();text+=`<h3>Página ${i}</h3><p>${esc(content.items.map(x=>x.str).join(' '))}</p>`;}
            c.contentHtml=text||c.contentHtml;
          }else{
            recordAudit('SYSTEM_ERROR','No se pudo convertir el PDF a texto editable: falta el lector pdf.js.','error');
          }
        }
      }catch(parseErr){
        // El archivo original queda guardado y se puede seguir viendo/descargando aunque
        // la conversión a texto editable haya fallado (por ejemplo, un PDF escaneado sin texto).
        recordAudit('SYSTEM_ERROR','No se pudo convertir el contrato a texto editable: '+(parseErr.message||parseErr),'error');
      }
      saveState();recordAudit('CONTRACT_ATTACH',`Archivo contractual cargado desde Gestión: ${file.name}`);toast('Contrato cargado correctamente.');
      openPropertyContractModal(p,c);
    }catch(e){recordAudit('SYSTEM_ERROR','Error al cargar contrato desde Gestión: '+(e.message||e),'error');toast('No se pudo cargar el contrato.');}
  };

  function contractEditorHtml(c={},propertyId=''){
    const props=accountProperties(), pId=propertyId||c.propertyId||'';
    return `<div class="contracts-editor-panel">
      <div class="contract-editor-header"><div><div class="section-kicker">Contrato</div><h3>${esc(c.title||'Contrato de alquiler')}</h3><span class="muted contract-autosave-status" id="contractAutosaveStatus">${c.id?'Guardado automáticamente':'Nuevo contrato'}</span></div><div class="actions contract-editor-actions"><input id="contractFile" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onchange="window.prepareInlineContractFile()"><button type="button" class="btn contract-icon-btn" onclick="document.getElementById('contractFile')?.click()" title="Cargar contrato PDF o Word" aria-label="Cargar contrato">📄 Cargar</button><button type="button" class="btn btn-primary contract-icon-btn" onclick="window.saveInlineContract('${c.id||''}')" title="Guardar contrato" aria-label="Guardar contrato">✓ Guardar</button><button type="button" class="btn contract-icon-btn" onclick="window.newInlineContract()" title="Nuevo contrato" aria-label="Nuevo contrato">＋ Nuevo</button><button type="button" class="btn contract-icon-btn" onclick="window.downloadActiveContract()" title="Descargar contrato" aria-label="Descargar contrato">↓ Descargar</button></div></div>
      <div class="contract-editor-meta"><div class="form-group"><label>Título del contrato</label><input id="cTitle" value="${esc(c.title||'Contrato de alquiler')}" oninput="window.scheduleContractAutosave()"></div><div class="form-group"><label>Inmueble</label><select id="cProperty" onchange="window.scheduleContractAutosave()"><option value="">Seleccionar inmueble</option>${props.map(p=>`<option value="${esc(p.id)}" ${pId===p.id?'selected':''}>${esc(p.title)} — ${esc(p.tenant||'Sin inquilino')}</option>`).join('')}</select></div><div class="form-group"><label>Inicio</label><input id="cStart" type="date" value="${esc(c.startDate||'')}" onchange="window.scheduleContractAutosave()"></div><div class="form-group"><label>Día de cobro</label><input id="cDueDay" type="number" min="1" max="31" value="${c.dueDay?esc(c.dueDay):''}" placeholder="5" onchange="window.scheduleContractAutosave()"></div></div>
      <div class="editor-toolbar" role="toolbar" aria-label="Herramientas del editor">
        <select title="Estilo" onchange="window.editorFormatBlock(this.value)"><option value="p">Párrafo</option><option value="h1">Título 1</option><option value="h2">Título 2</option><option value="h3">Título 3</option><option value="blockquote">Cita</option></select>
        <select title="Tipografía" onchange="window.editorFont(this.value)"><option value="Arial">Arial</option><option value="Times New Roman">Times New Roman</option><option value="Georgia">Georgia</option><option value="Verdana">Verdana</option><option value="Tahoma">Tahoma</option><option value="Calibri">Calibri</option></select>
        <select title="Tamaño" onchange="window.editorSize(this.value)"><option value="2">10</option><option value="3" selected>12</option><option value="4">14</option><option value="5">18</option><option value="6">24</option><option value="7">32</option></select>
        <button type="button" onclick="window.execEditor('bold')" title="Negrita"><b>N</b></button><button type="button" onclick="window.execEditor('italic')" title="Cursiva"><i>C</i></button><button type="button" onclick="window.execEditor('underline')" title="Subrayado"><u>S</u></button><button type="button" onclick="window.execEditor('strikeThrough')" title="Tachado"><s>T</s></button>
        <label class="editor-color" title="Color de texto">A <input id="editorTextColor" type="color" value="#222222" onchange="window.editorColor(this.value)"></label><label class="editor-color" title="Resaltado">▰ <input id="editorHighlight" type="color" value="#fff2a8" onchange="window.editorHighlight(this.value)"></label>
        <button type="button" onclick="window.execEditor('insertUnorderedList')">• Lista</button><button type="button" onclick="window.execEditor('insertOrderedList')">1. Lista</button><button type="button" onclick="window.execEditor('outdent')">← Sangría</button><button type="button" onclick="window.execEditor('indent')">→ Sangría</button>
        <button type="button" onclick="window.execEditor('justifyLeft')">Izq.</button><button type="button" onclick="window.execEditor('justifyCenter')">Centro</button><button type="button" onclick="window.execEditor('justifyRight')">Der.</button><button type="button" onclick="window.execEditor('justifyFull')">Just.</button>
        <button type="button" onclick="window.editorLink()">Enlace</button><button type="button" onclick="window.insertContractTable()">Tabla</button><button type="button" onclick="window.execEditor('removeFormat')">Limpiar formato</button>
      </div>
      <div class="contract-page-shell"><div id="contractEditor" class="contract-editor" contenteditable="true" spellcheck="true" role="textbox" aria-multiline="true" aria-label="Editor de contrato" oninput="window.scheduleContractAutosave()">${c.contentHtml||'<h2>CONTRATO DE ALQUILER</h2><p>Entre las partes que suscriben el presente contrato...</p><p><br></p>'}</div></div>
      <div id="contractFileInfo" class="file-info contract-inline-file-info">${c.fileName?`Archivo cargado: <strong>${esc(c.fileName)}</strong>`:'No hay archivo contractual cargado.'}</div>
    </div>`;
  }
  function contractsView(title){
    const contracts=accountContracts().sort((a,b)=>new Date(b.updatedAt||b.createdAt||0)-new Date(a.updatedAt||a.createdAt||0));
    if(activeContractId && !contracts.some(c=>c.id===activeContractId)) activeContractId=null;
    let active;
    if(pendingBlankContract){
      active={id:'',title:'Contrato de alquiler',propertyId:'',startDate:'',dueDay:null,contentHtml:'',fileData:'',fileName:'',fileType:''};
      pendingBlankContract=false; // se consume una sola vez: el próximo render ya vuelve al comportamiento normal
    }else{
      active=contracts.find(c=>c.id===activeContractId)||contracts[0]||{id:'',title:'Contrato de alquiler',propertyId:'',startDate:'',dueDay:null,contentHtml:'',fileData:'',fileName:'',fileType:''};
    }
    if(active.id) activeContractId=active.id;
    setTimeout(()=>bindContractAutosave(),0);
    return `<div class="admin-head"><h2>${title}</h2></div><div class="contracts-inline-wrap"><div class="contracts-editor-area">${contractEditorHtml(active,active.propertyId||'')}</div><div class="contract-file-section"><div class="contract-file-section-head"><div><span class="section-kicker">Archivo contractual</span><strong>${contracts.length} contrato(s)</strong></div><span class="muted">Seleccioná un contrato para visualizarlo y editarlo.</span></div>${contracts.length?`<div class="contracts-table-wrap"><table class="admin contract-files-table"><thead><tr><th>Contrato</th><th>Propiedad</th><th>Inicio</th><th>Documento</th><th>Actualizado</th><th>Acciones</th></tr></thead><tbody>${contracts.map(c=>{const pr=contractProperty(c);return `<tr class="${c.id===activeContractId?'contract-selected-row':''}"><td><strong>${esc(c.title||'Contrato sin título')}</strong></td><td>${esc(pr?.title||'—')}</td><td>${c.startDate?esc(formatDate(c.startDate)):'—'}</td><td>${c.fileName?`<span class="file-badge">${esc(c.fileName)}</span>`:'<span class="muted">Editor interno</span>'}</td><td>${esc(dateTime(c.updatedAt||c.createdAt))}</td><td><div class="row-actions"><button class="btn btn-small" onclick="window.openContractEditor('${c.id}')">Editar</button>${c.fileName?`<button class="btn btn-small" onclick="window.downloadContractFile('${c.id}')">↓ Descargar</button>`:''}<button class="btn btn-small btn-danger" onclick="window.deleteContract('${c.id}')">Eliminar</button></div></td></tr>`}).join('')}</tbody></table></div>`:'<div class="empty contract-empty">Todavía no hay contratos cargados. Podés asociar uno desde una propiedad y luego editarlo aquí.</div>'}</div></div>`;
  }
  function bindContractAutosave(){
    const ed=$('#contractEditor'); if(!ed || ed.dataset.autosaveBound==='1')return;
    ed.dataset.autosaveBound='1';
  }
  let contractSaveTimer=null;
  window.scheduleContractAutosave=()=>{clearTimeout(contractSaveTimer);const st=$('#contractAutosaveStatus');if(st)st.textContent='Cambios sin guardar…';contractSaveTimer=setTimeout(()=>window.saveInlineContract(activeContractId||'',true),700);};
  window.selectInlineContract=id=>{pendingBlankContract=false;activeContractId=id||null;view='contracts';renderPanel();};
  window.newInlineContract=()=>{
    clearTimeout(contractSaveTimer);
    const ed=$('#contractEditor');
    const defaultHtml='<h2>CONTRATO DE ALQUILER</h2><p>Entre las partes que suscriben el presente contrato...</p><p><br></p>';
    const hayContenidoSinGuardar = ed && ed.innerHTML && ed.innerHTML!==defaultHtml && ed.innerHTML.replace(/<[^>]*>/g,'').trim()!=='';
    if(activeContractId){
      // Había un contrato abierto: lo autoguardamos tal cual quedó en el editor antes de vaciarlo.
      window.saveInlineContract(activeContractId,true);
    }else if(hayContenidoSinGuardar){
      // Había texto tipeado en un contrato todavía sin guardar: lo guardamos como contrato nuevo
      // antes de perderlo, para que quede en "Archivo contractual".
      window.saveInlineContract('',true);
    }
    activeContractId=null;
    pendingBlankContract=true;
    view='contracts';
    renderPanel();
    setTimeout(()=>$('#contractEditor')?.scrollIntoView({behavior:'smooth',block:'start'}),80);
  };
  window.openContractEditor=async id=>{
    const c=contractById(id);if(!c){toast('No se encontró el contrato.');return;}
    clearTimeout(contractSaveTimer);pendingBlankContract=false;$('#modal')?.remove();activeContractId=c.id;view='contracts';
    // Recupera el archivo asociado antes de renderizar, evitando estados parciales después de recargar.
    await ensureContractFileData(c);
    renderPanel();
    setTimeout(()=>{const ed=$('#contractEditor');if(ed){ed.focus();ed.scrollIntoView({behavior:'smooth',block:'start'});}},120);
  };
  window.openSavedContract=id=>{pendingBlankContract=false;activeContractId=id;view='contracts';renderPanel();};
  window.downloadActiveContract=()=>{const id=activeContractId,c=id?contractById(id):null;if(c){window.exportContractDocx(id);return;}const title=$('#cTitle')?.value?.trim()||'Contrato de alquiler';const fake={title,contentHtml:$('#contractEditor')?.innerHTML||'<p></p>'};window.exportContractDocx(fake);};
  window.prepareInlineContractFile=async()=>{const file=$('#contractFile')?.files?.[0];if(!file)return;if(file.size>4*1024*1024){toast('El archivo supera 4 MB.');$('#contractFile').value='';return;}const info=$('#contractFileInfo');if(info)info.innerHTML=`Archivo cargado: <strong>${esc(file.name)}</strong>`;let c=activeContractId?contractById(activeContractId):null;if(!c){
      c={id:uid('contract'),accountId:accountId(),propertyId:$('#cProperty')?.value||'',title:$('#cTitle')?.value?.trim()||file.name.replace(/\.[^.]+$/,''),startDate:$('#cStart')?.value||'',dueDay:Math.min(31,Math.max(0,Number($('#cDueDay')?.value)||0))||null,contentHtml:$('#contractEditor')?.innerHTML||'<p></p>',fileData:'',fileName:'',fileType:'',specialCases:[],createdAt:new Date().toISOString(),active:true};
      state.contracts.push(c);activeContractId=c.id;snapshot('Backup previo a alta de contrato');
    }
    try{
      c.fileData=await contractFileToDataUrl(file);c.fileName=file.name;c.fileType=file.type||'application/octet-stream';c.updatedAt=new Date().toISOString();
      await idbSetFile(c.id,c.fileData);
      const ed=$('#contractEditor');
      if(/\.docx$/i.test(file.name)){
        if(!window.mammoth){toast('No se pudo cargar el importador Word.');return;}
        const ab=await file.arrayBuffer();const result=await mammoth.convertToHtml({arrayBuffer:ab,styleMap:['p[style-name="Title"] => h1:fresh','p[style-name="Heading 1"] => h2:fresh','p[style-name="Heading 2"] => h3:fresh']});if(ed)ed.innerHTML=result.value||'<p></p>';
      }else if(/\.pdf$/i.test(file.name)||file.type==='application/pdf'){
        if(!window.pdfjsLib&&window.pdfjsLibPromise)await window.pdfjsLibPromise;if(!window.pdfjsLib){toast('No se pudo cargar el lector PDF.');return;}
        const ab=await file.arrayBuffer(),pdf=await pdfjsLib.getDocument({data:new Uint8Array(ab)}).promise;let text='';for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i),content=await page.getTextContent();text+=`<h3>Página ${i}</h3><p>${esc(content.items.map(x=>x.str).join(' '))}</p>`;}if(ed)ed.innerHTML=text||'<p>El PDF no contiene texto extraíble. El original queda conservado.</p>';
      }
      // Importante: el archivo original queda en IndexedDB y, además, el contenido convertido
      // se persiste en el contrato para que "Editar" siga mostrando el documento tras recargar.
      if(ed) c.contentHtml=ed.innerHTML||c.contentHtml||'<p></p>';
      saveState();recordAudit('CONTRACT_ATTACH',`Archivo contractual cargado: ${file.name}`);toast('Contrato cargado correctamente.');const st=$('#contractAutosaveStatus');if(st)st.textContent='Guardado automáticamente';
    }catch(e){recordAudit('SYSTEM_ERROR','Error al cargar contrato: '+(e.message||e),'error');toast('No se pudo cargar el contrato.');}
  };
  window.saveInlineContract=async(id,silent=false)=>{const ed=$('#contractEditor');if(!ed)return;let old=id?contractById(id):null;if(!old){
      old={id:uid('contract'),accountId:accountId(),propertyId:$('#cProperty')?.value||'',title:$('#cTitle')?.value?.trim()||'Contrato de alquiler',startDate:$('#cStart')?.value||'',dueDay:Math.min(31,Math.max(0,Number($('#cDueDay')?.value)||0))||null,contentHtml:ed.innerHTML,fileData:'',fileName:'',fileType:'',specialCases:[],createdAt:new Date().toISOString(),active:true};state.contracts.push(old);activeContractId=old.id;snapshot('Backup previo a alta de contrato');
    }
    old.title=$('#cTitle')?.value?.trim()||old.title||'Contrato de alquiler';old.propertyId=$('#cProperty')?.value||old.propertyId||'';old.startDate=$('#cStart')?.value||'';old.dueDay=Math.min(31,Math.max(0,Number($('#cDueDay')?.value)||0))||null;old.contentHtml=ed.innerHTML;old.updatedAt=new Date().toISOString();
    if(old.propertyId){const p=state.properties.find(x=>x.id===old.propertyId&&x.accountId===accountId());if(p){p.contractStartDate=old.startDate;p.rentDueDay=old.dueDay;p.rentToleranceDays=Number(p.rentToleranceDays)||5;p.updatedAt=new Date().toISOString();}}
    saveState();const st=$('#contractAutosaveStatus');if(st)st.textContent='Guardado correctamente';if(!silent){toast('Contrato guardado correctamente.');setTimeout(()=>renderPanel(),80);}
  };
  window.downloadContractFile=async id=>{const c=contractById(id);if(!c){toast('Contrato no encontrado.');return;}const data=await ensureContractFileData(c);if(!data){toast('Este contrato no tiene un archivo cargado.');return;}const a=document.createElement('a');a.href=data;a.download=c.fileName||'contrato';document.body.appendChild(a);a.click();a.remove();recordAudit('CONTRACT_DOWNLOAD','Descargado archivo contractual '+(c.fileName||c.title||'sin nombre')+'.');};
  window.viewContractFile=async id=>{const c=contractById(id);if(!c?.fileName)return;const win=window.open('','_blank');if(!win){toast('El navegador bloqueó la ventana.');return;}const data=await ensureContractFileData(c);if(!data){win.close();toast('Este contrato no tiene un archivo cargado.');return;}if(/pdf/i.test(c.fileType)||/\.pdf$/i.test(c.fileName||'')){win.document.write(`<title>${esc(c.fileName)}</title><iframe style="width:100%;height:100vh;border:0" src="${data}"></iframe>`);}else{const a=document.createElement('a');a.href=data;a.download=c.fileName||'contrato.docx';document.body.appendChild(a);a.click();a.remove();win.close();}};
  window.exportContractDocx=id=>{const c=contractById(id)||{title:$('#cTitle')?.value||'Contrato',contentHtml:$('#contractEditor')?.innerHTML||''};if(!window.htmlDocx){toast('No se pudo cargar el exportador Word.');return;}const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;font-size:11pt;line-height:1.5;margin:2cm}table{border-collapse:collapse;width:100%}td{border:1px solid #777;padding:6px}h1,h2,h3{margin-bottom:12pt}</style></head><body>${c.contentHtml||'<p></p>'}</body></html>`;const blob=htmlDocx.asBlob(html);const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${safeName(c.title||'contrato')}.docx`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1500);recordAudit('CONTRACT_EXPORT_DOCX',`Exportado contrato ${c.title||'sin título'} a Word.`);};
  window.deleteContract=id=>{const c=contractById(id);if(!c)return;if(!confirm(`Eliminar el contrato "${c.title}"?`))return;snapshot('Backup previo a eliminación de contrato');state.contracts=state.contracts.filter(x=>x.id!==id);if(c.fileName)idbDeleteFile(id);activeContractId=null;recordAudit('CONTRACT_DELETE',`Eliminado contrato ${c.title}`,'warning');saveState();renderPanel();toast('Contrato eliminado.');};

  // Índices oficiales más usados para actualizar alquileres en Argentina (BCRA/INDEC).
  // Los valores no se traen en vivo (la app no tiene backend): se cargan y actualizan a mano
  // en "Valores de índice registrados", y el calculador usa el más cercano a cada fecha pedida.
  const RENT_INDICES = [
    {key:'icl',label:'ICL (BCRA)'},
    {key:'ipc',label:'IPC (INDEC)'},
    {key:'casapropia',label:'Casa Propia'},
    {key:'cac',label:'CAC'},
    {key:'is',label:'IS'},
    {key:'ipim',label:'IPIM'},
    {key:'cer',label:'CER (BCRA)'},
    {key:'uva',label:'UVA (BCRA)'}
  ];
  function rentIndexLabel(key){ return RENT_INDICES.find(x=>x.key===key)?.label||key; }
  function rentIndexSeries(key){
    if(!state.settings.rentIndices) state.settings.rentIndices={};
    if(!Array.isArray(state.settings.rentIndices[key])) state.settings.rentIndices[key]=[];
    return state.settings.rentIndices[key];
  }
  // Nunca usar valores posteriores a la fecha consultada: evita ajustes ficticios.
  function closestIndexValue(key,dateStr){
    const series=rentIndexSeries(key).filter(r=>r.date<=dateStr&&Number(r.value)>0).sort((a,b)=>a.date.localeCompare(b.date));
    return series.at(-1)||null;
  }
  function addMonthsClamped(dateStr,months){
    const [year,month,day]=dateStr.split('-').map(Number);
    if(!year||!month||!day||months<1||months>12)return '';
    const target=new Date(Date.UTC(year,month-1+months,1));
    target.setUTCDate(Math.min(day,new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate()));
    return target.toISOString().slice(0,10);
  }
  function rentIndexHistoryHtml(){
    return RENT_INDICES.map(ix=>{
      const series=rentIndexSeries(ix.key).slice().sort((a,b)=>new Date(b.date)-new Date(a.date));
      const rows=series.slice(0,4).map(r=>`<div class="index-history-row"><span>${esc(r.date)}</span><strong>${Number(r.value).toLocaleString('es-AR',{maximumFractionDigits:4})}</strong></div>`).join('')||'<div class="muted index-history-empty">Sin valores cargados todavía.</div>';
      return `<div class="index-history-group"><div class="index-history-title">${esc(ix.label)}</div>${rows}</div>`;
    }).join('');
  }
  window.saveIndexValue=()=>{
    const key=$('#idxKeyInput')?.value,date=$('#idxDateInput')?.value,value=Number($('#idxValueInput')?.value);
    if(!key||!date){toast('Elegí el índice y la fecha.');return;}
    if(!(value>0)){toast('Ingresá un valor de índice válido.');return;}
    const series=rentIndexSeries(key);
    const existing=series.find(r=>r.date===date);
    if(existing) existing.value=value; else series.push({date,value});
    saveState();
    recordAudit('RENT_INDEX_UPDATE',`Valor de índice registrado: ${rentIndexLabel(key)} ${date} = ${value}`);
    toast('Valor de índice guardado.');
    renderPanel();
  };
  window.lookupIndexValues=()=>{
    const key=$('#indexType')?.value, start=$('#indexDateStart')?.value;
    const months=Number($('#contractMonths')?.value);
    const end=start?addMonthsClamped(start,months):'';
    if($('#indexDateEnd'))$('#indexDateEnd').value=end;
    const s=$('#indexStart'),e=$('#indexEnd');if(s)s.value='';if(e)e.value='';
    const box=$('#indexResult');if(box)box.innerHTML='';
    if(!start||!end)return;
    const vs=closestIndexValue(key,start),ve=closestIndexValue(key,end);
    if(vs&&ve){s.value=vs.value;e.value=ve.value;}
    const status=$('#indexDataStatus');
    if(status)status.textContent=vs&&ve?`Valores registrados: ${vs.date} y ${ve.date}. Revisá la metodología y vigencia del índice pactado.`:'No hay valores suficientes publicados/cargados para ambas fechas. Completalos en «Valores de índice registrados»; no se estimarán valores futuros.';
  };
  function rentalsView(title){
    const props=accountProperties().filter(p=>p.status==='Alquilado');
    const first=props[0];
    const opts=RENT_INDICES.map(ix=>`<option value="${ix.key}">${esc(ix.label)}</option>`).join('');
    const monthOptions=Array.from({length:12},(_,i)=>`<option value="${i+1}" ${i===2?'selected':''}>${i+1} ${i?'meses':'mes'}</option>`).join('');
    return `<div class="admin-head"><h2>${title}</h2></div>
    <section class="panel rental-main-calculator"><div class="panel-head"><h3>Calculadora de actualización de alquileres</h3></div>
    <div class="form-group"><label>Propiedad / contrato (opcional)</label><select id="rentProperty" onchange="window.syncRentalProperty()"><option value="">Cálculo independiente</option>${props.map(p=>`<option value="${esc(p.id)}">${esc(p.title)} · ${esc(p.tenant||'Sin inquilino')}</option>`).join('')}</select></div>
    <div class="form-group"><label>Valor inicial del alquiler ($)</label><input id="rentBase" type="number" min="0.01" step="0.01" value="${Number(first?.rent)||''}" placeholder="Ej. 500000"></div>
    <div class="form-group"><label>Fecha de inicio del contrato</label><input id="indexDateStart" type="date" value="${esc(first?.contractStartDate||'')}" onchange="window.lookupIndexValues()"></div>
    <div class="form-group"><label>Se actualiza cada (meses)</label><select id="contractMonths" onchange="window.lookupIndexValues()">${monthOptions}</select></div>
    <div class="form-group"><label>Índice pactado</label><select id="indexType" onchange="window.lookupIndexValues()">${opts}</select></div>
    <input id="indexDateEnd" type="hidden"><input id="indexStart" type="hidden"><input id="indexEnd" type="hidden">
    <div class="notice" id="indexDataStatus">Los índices deben estar registrados con fecha y valor oficiales. No se inventan datos faltantes.</div>
    <button type="button" class="btn btn-primary" onclick="window.calculateIndex(false)">Calcular actualización</button>
    <div id="indexResult" class="result-space"></div>
    <p class="muted">Inspirado en la idea de la calculadora de <a href="https://arquiler.com/" target="_blank" rel="noopener noreferrer">ARquiler (arquiler.com)</a>. Desarrollo y cálculos independientes; sin afiliación.</p></section>
    <section class="panel"><div class="panel-head"><h3>Alternativa por porcentaje</h3></div><div class="form-row"><div class="form-group"><label>Alquiler base</label><input id="rentPctBase" type="number" min="0" step="0.01" value="${Number(first?.rent)||0}"></div><div class="form-group"><label>Variación acordada (%)</label><input id="rentPct" type="number" step="0.01" value="0"></div></div><button class="btn btn-primary" onclick="window.calculatePct()">Calcular porcentaje</button><div id="pctResult" class="result-space"></div></section>
    <section class="panel"><div class="panel-head"><h3>Valores de índice registrados</h3><span class="muted">Cargá valores oficiales publicados con su fecha. El cálculo no consulta fuentes en vivo.</span></div><div class="form-row"><div class="form-group"><label>Índice</label><select id="idxKeyInput">${opts}</select></div><div class="form-group"><label>Fecha</label><input id="idxDateInput" type="date" value="${fmtDateInput()}"></div><div class="form-group"><label>Valor</label><input id="idxValueInput" type="number" min="0" step="any"></div></div><button type="button" class="btn btn-primary" onclick="window.saveIndexValue()">Guardar valor</button><div class="index-history-grid">${rentIndexHistoryHtml()}</div></section>`;
  }
  window.syncRentalProperty=()=>{const p=state.properties.find(x=>x.id===$('#rentProperty')?.value&&x.accountId===accountId());if(!p)return;$('#rentBase').value=Number(p.rent)||0;$('#rentPctBase').value=Number(p.rent)||0;$('#indexDateStart').value=p.contractStartDate||'';window.lookupIndexValues();};
  window.calculateIndex=(silent=false)=>{
    window.lookupIndexValues();
    const base=Number($('#rentBase')?.value),s=Number($('#indexStart')?.value),e=Number($('#indexEnd')?.value),start=$('#indexDateStart')?.value,end=$('#indexDateEnd')?.value,box=$('#indexResult');
    if(!(base>0&&s>0&&e>0&&start&&end&&end>start)){if(!silent&&box)box.innerHTML='<div class="notice warning">Faltan valores registrados válidos para las fechas seleccionadas. Revisá la serie del índice y cargá los datos oficiales correspondientes.</div>';return;}
    const factor=e/s,pct=(factor-1)*100,newRent=base*factor;
    if(box)box.innerHTML=`<div class="calc-result"><div><span class="muted">Fecha de actualización</span><div class="big">${esc(end)}</div></div><div><span class="muted">Variación</span><div class="big">${pct.toFixed(2)}%</div></div><div><span class="muted">Aumento</span><div class="big">${money(newRent-base)}</div></div><div><span class="muted">Nuevo alquiler</span><div class="big">${money(newRent)}</div></div></div><p class="muted">${money(base)} × (${e} ÷ ${s}) = ${money(newRent)}. Resultado orientativo sujeto a metodología y publicación del índice pactado.</p>`;
    if(!silent)recordAudit('RENT_INDEX_CALC',`Cálculo ${rentIndexLabel($('#indexType').value)}: ${pct.toFixed(2)}% sobre ${money(base)}`);
  };
  window.calculatePct=()=>{const b=Number($('#rentPctBase')?.value),p=Number($('#rentPct')?.value);if(!(Number.isFinite(b)&&b>=0&&Number.isFinite(p))){toast('Datos inválidos.');return;}const n=b*(1+p/100);$('#pctResult').innerHTML=`<div class="calc-result"><div><span class="muted">Variación</span><div class="big">${p.toFixed(2)}%</div></div><div><span class="muted">Nuevo alquiler</span><div class="big">${money(n)}</div></div></div>`;recordAudit('RENT_PCT_CALC',`Cálculo ${p}% sobre ${money(b)}`);};

  // Expensas: arma los campos de carga de importes según lo que la propiedad tenga tildado.
  function expenseValueFields(prop,prefix){
    if(!prop) return '';
    const ord=prop.expensesOrdinary||[], ext=prop.expensesExtraordinary||[];
    if(!ord.length && !ext.length) return '';
    const row=(key,label)=>`<div class="form-group"><label>${esc(label)}</label><input type="number" min="0" step="0.01" placeholder="0" id="${prefix}_exp_${key}"></div>`;
    let html='<div class="contract-data-box expense-values-box">';
    if(ord.length) html+=`<div class="section-kicker">Expensas ordinarias del período</div><div class="form-row expense-input-grid">${ord.map(k=>row(k,expenseLabel('ordinary',k))).join('')}</div>`;
    if(ext.length) html+=`<div class="section-kicker">Expensas extraordinarias del período</div><div class="form-row expense-input-grid">${ext.map(k=>row(k,expenseLabel('extraordinary',k))).join('')}</div>`;
    html+='</div>';
    return html;
  }
  window.renderPaymentExpenseFields=(selectId,containerId,prefix)=>{
    const propId=$('#'+selectId)?.value;
    const prop=state.properties.find(p=>p.id===propId&&p.accountId===accountId());
    const box=$('#'+containerId); if(box) box.innerHTML=expenseValueFields(prop,prefix);
  };
  function collectExpenseGroupValues(prefix,keys){
    const vals={};
    (keys||[]).forEach(k=>{ const v=Number($('#'+prefix+'_exp_'+k)?.value)||0; if(v>0) vals[k]=v; });
    return vals;
  }

  function buildOtherPaymentValue(prefix){
    const description=$('#'+prefix+'OtherDesc')?.value?.trim()||'',amount=Number($('#'+prefix+'OtherAmount')?.value)||0,target=$('#'+prefix+'OtherTarget')?.value||'tenant';
    if(!description||amount<=0)return {tenant:{description:'',amount:0},owner:{description:'',amount:0}};
    return {tenant:target==='tenant'?{description,amount}:{description:'',amount:0},owner:target==='owner'?{description,amount}:{description:'',amount:0}};
  }

  function paymentsBaseView(title){
    const payments=accountPayments().sort((a,b)=>new Date(b.fecha||b.createdAt)-new Date(a.fecha||a.createdAt));
    const props=accountProperties();
    return `<div class="admin-head"><h2>${title}</h2></div>
    <div class="panel"><div class="panel-head"><h3>Registrar pago</h3><span class="muted">Cada pago genera automáticamente un recibo.</span></div>
    <div class="form-row"><div class="form-group"><label>Propiedad *</label><select id="pgProperty" onchange="window.renderPaymentExpenseFields('pgProperty','pgExpenses','pg')"><option value="">Seleccioná una propiedad...</option>${props.map(p=>`<option value="${esc(p.id)}">${esc(p.title)} — ${esc(p.tenant||'Sin inquilino')}</option>`).join('')}</select></div><div class="form-group"><label>Período *</label><input id="pgPeriod" type="month" value="${new Date().toISOString().slice(0,7)}"></div></div>
    <div class="form-row"><div class="form-group"><label>Importe abonado *</label><input id="pgAmount" type="number" min="0" step="0.01"></div><div class="form-group"><label>Fecha de pago</label><input id="pgDate" type="date" value="${fmtDateInput()}"></div></div>
    <div id="pgExpenses"></div><div class="contract-data-box other-payment-box"><div class="section-kicker">Otros · casos extraordinarios</div><div class="form-row"><div class="form-group"><label>Descripción</label><input id="pgOtherDesc" placeholder="Ej. Reparación excepcional"></div><div class="form-group"><label>Importe</label><input id="pgOtherAmount" type="number" min="0" step="0.01" placeholder="0"></div></div><div class="form-group"><label>Aplicar a</label><select id="pgOtherTarget"><option value="tenant">Inquilino · suma al recibo</option><option value="owner">Propietario · se descuenta de la liquidación</option></select></div></div>
    <div class="form-row"><div class="form-group"><label>Método de pago</label><select id="pgMethod"><option>Transferencia</option><option>Efectivo</option><option>Depósito</option><option>Mercado Pago</option><option>Otro</option></select></div><div class="form-group"><label>Observaciones</label><input id="pgNotes" placeholder="Opcional"></div></div>
    <button class="btn btn-primary" onclick="window.registerPayment()">Registrar pago y generar recibo</button></div>
    <div class="panel"><div class="panel-head"><h3>Pagos recientes</h3><span class="muted">${payments.length} registrado(s)</span></div>${payments.length?`<div class="table-wrap"><table class="admin"><thead><tr><th>Fecha</th><th>Propiedad</th><th>Período</th><th>Inquilino</th><th>Importe</th></tr></thead><tbody>${payments.slice(0,20).map(paymentRow).join('')}</tbody></table></div>`:'<div class="empty">Todavía no hay pagos registrados.</div>'}</div>`;
  }
  function paymentRow(pg){const prop=state.properties.find(p=>p.id===pg.propertyId);return `<tr><td>${esc(pg.fecha||'—')}</td><td><strong>${esc(prop?.title||'Propiedad eliminada')}</strong></td><td>${esc(pg.periodo||'—')}</td><td>${esc(pg.inquilino||prop?.tenant||'—')}</td><td><strong>${money(pg.monto)}</strong></td></tr>`;}
  function paymentModal(propertyId=''){
    $('#modal')?.remove();
    const props=accountProperties(),prop=props.find(p=>p.id===propertyId);
    document.body.insertAdjacentHTML('beforeend',`<div class="overlay open" id="modal"><div class="drawer" role="dialog" aria-modal="true" aria-label="Registrar pago"><button class="close" onclick="window.closeModal()">×</button><h3>Registrar pago</h3><div class="notice"><strong>Generación automática:</strong> al registrar el pago se crea el recibo asociado.</div>
    <div class="form-row"><div class="form-group"><label>Propiedad *</label><select id="mPgProperty" onchange="window.renderPaymentExpenseFields('mPgProperty','mPgExpenses','mPg')"><option value="">Seleccioná una propiedad...</option>${props.map(p=>`<option value="${esc(p.id)}" ${p.id===propertyId?'selected':''}>${esc(p.title)} — ${esc(p.tenant||'Sin inquilino')}</option>`).join('')}</select></div><div class="form-group"><label>Período *</label><input id="mPgPeriod" type="month" value="${new Date().toISOString().slice(0,7)}"></div></div>
    <div class="form-row"><div class="form-group"><label>Importe abonado *</label><input id="mPgAmount" type="number" min="0" step="0.01" value="${Number(prop?.rent)||0}"></div><div class="form-group"><label>Fecha de pago</label><input id="mPgDate" type="date" value="${fmtDateInput()}"></div></div>
    <div id="mPgExpenses">${expenseValueFields(prop,'mPg')}</div><div class="contract-data-box other-payment-box"><div class="section-kicker">Otros · casos extraordinarios</div><div class="form-row"><div class="form-group"><label>Descripción</label><input id="mPgOtherDesc" placeholder="Ej. Reparación excepcional"></div><div class="form-group"><label>Importe</label><input id="mPgOtherAmount" type="number" min="0" step="0.01" placeholder="0"></div></div><div class="form-group"><label>Aplicar a</label><select id="mPgOtherTarget"><option value="tenant">Inquilino · suma al recibo</option><option value="owner">Propietario · se descuenta de la liquidación</option></select></div></div>
    <div class="form-row"><div class="form-group"><label>Método de pago</label><select id="mPgMethod"><option>Transferencia</option><option>Efectivo</option><option>Depósito</option><option>Mercado Pago</option><option>Otro</option></select></div><div class="form-group"><label>Observaciones</label><input id="mPgNotes" placeholder="Opcional"></div></div>
    <div class="form-actions"><button class="btn btn-primary" onclick="window.registerPaymentFromModal()">Registrar pago y generar recibo</button><button class="btn" onclick="window.closeModal()">Cancelar</button></div></div></div>`);
  }
  window.openPaymentModal=()=>paymentModal();
  window.openPropertyPayment=id=>paymentModal(id);
  window.registerPaymentFromModal=()=>{const propId=$('#mPgProperty')?.value,period=$('#mPgPeriod')?.value,amount=Number($('#mPgAmount')?.value),fecha=$('#mPgDate')?.value||fmtDateInput(),method=$('#mPgMethod')?.value||'Otro',notes=$('#mPgNotes')?.value.trim()||'',prop=state.properties.find(p=>p.id===propId&&p.accountId===accountId());if(!prop){toast('Seleccioná una propiedad.');return;}if(!period){toast('Indicá el período.');return;}if(!(amount>0)){toast('Ingresá un importe válido.');return;}const duplicate=accountPayments().find(p=>p.propertyId===prop.id&&p.periodo===period);if(duplicate&&!confirm('Ya existe un pago para esta propiedad y período. ¿Registrar igualmente?'))return;snapshot('Backup previo a registro de pago');const pg={id:uid('pay'),accountId:accountId(),propertyId:prop.id,periodo:period,monto:amount,moneda:'ARS',fecha,metodo:method,notas:notes,inquilino:prop.tenant||'',propietario:prop.owner||'',expensesOrdinary:collectExpenseGroupValues('mPg',prop.expensesOrdinary),expensesExtraordinary:collectExpenseGroupValues('mPg',prop.expensesExtraordinary),others:buildOtherPaymentValue('mPg'),createdAt:new Date().toISOString()};state.payments.unshift(pg);const receipt=createReceiptForPayment(pg);saveState();recordAudit('PAYMENT_CREATE',`Pago registrado: ${prop.title} — ${period} — ${money(amount)}`);closeModal();view='properties';renderPanel();toast('Pago registrado y recibo generado.');setTimeout(()=>openReceiptInternal(receipt.id),0);};
  window.registerPayment=()=>{
    const prop=state.properties.find(p=>p.id===$('#pgProperty')?.value&&p.accountId===accountId()),period=$('#pgPeriod')?.value,amount=Number($('#pgAmount')?.value),fecha=$('#pgDate')?.value||fmtDateInput(),method=$('#pgMethod')?.value||'Otro',notes=$('#pgNotes')?.value.trim()||'';
    if(!prop){toast('Seleccioná una propiedad.');return;} if(!period){toast('Indicá el período.');return;} if(!(amount>0)){toast('Ingresá un importe válido.');return;}
    const duplicate=accountPayments().find(p=>p.propertyId===prop.id&&p.periodo===period);if(duplicate&&!confirm('Ya existe un pago para esta propiedad y período. ¿Registrar igualmente?'))return;
    snapshot('Backup previo a registro de pago');
    const pg={id:uid('pay'),accountId:accountId(),propertyId:prop.id,periodo:period,monto:amount,moneda:'ARS',fecha,metodo:method,notas:notes,inquilino:prop.tenant||'',propietario:prop.owner||'',expensesOrdinary:collectExpenseGroupValues('pg',prop.expensesOrdinary),expensesExtraordinary:collectExpenseGroupValues('pg',prop.expensesExtraordinary),others:buildOtherPaymentValue('pg'),createdAt:new Date().toISOString()};
    state.payments.unshift(pg);
    const receipt=createReceiptForPayment(pg);
    saveState();recordAudit('PAYMENT_CREATE',`Pago registrado: ${prop.title} — ${period} — ${money(amount)}`);view='payments';renderPanel();toast('Pago registrado y recibo generado.');setTimeout(()=>openReceiptInternal(receipt.id),0);
  };
  function createReceiptForPayment(pg){
    const existing=state.receipts.find(r=>r.paymentId===pg.id&&r.accountId===accountId());if(existing)return existing;
    const receipt={id:uid('receipt'),accountId:pg.accountId,paymentId:pg.id,numero:'R-'+String(100000+state.receipts.length+1),generadoEl:new Date().toISOString(),para:'inquilino',estado:'Generado'};
    state.receipts.unshift(receipt);return receipt;
  }

  // Desglose de expensas para el recibo: sólo se listan los ítems con importe cargado.
  function paymentAmounts(pg){
    const rent=Number(pg?.monto)||0;
    const ordinary=Object.values(pg?.expensesOrdinary||{}).reduce((s,v)=>s+(Number(v)||0),0);
    const extraordinary=Object.values(pg?.expensesExtraordinary||{}).reduce((s,v)=>s+(Number(v)||0),0);
    const othersTenant=Number(pg?.others?.tenant?.amount)||0;
    const othersOwner=Number(pg?.others?.owner?.amount)||0;
    return {rent,ordinary,extraordinary,othersTenant,othersOwner,
      tenantTotal:rent+ordinary+othersTenant,
      ownerTotal:Math.max(0,rent-extraordinary-othersOwner)};
  }
  function expenseGrandTotalHtml(pg){
    const a=paymentAmounts(pg);return `<div class="receipt-total receipt-grand-total"><span>${pg?.__receiptPara==='propietario'?'Total a liquidar':'Total abonado'}</span><strong>${money(pg?.__receiptPara==='propietario'?a.ownerTotal:a.tenantTotal)}</strong></div>`;
  }
  function expenseBreakdownHtml(pg){
    const a=paymentAmounts(pg),para=pg?.__receiptPara||'inquilino';
    const lines=(entries,group)=>entries.map(([k,v])=>`<div class="expense-line"><span>${esc(expenseLabel(group,k))}</span><strong>${money(v)}</strong></div>`).join('');
    let html='<div class="receipt-expenses">';
    html+=`<div class="expense-group"><div class="expense-group-title">Alquiler</div><div class="expense-line"><span>Alquiler mensual</span><strong>${money(a.rent)}</strong></div></div>`;
    if(para==='inquilino'){
      const ordEntries=Object.entries(pg?.expensesOrdinary||{});
      if(ordEntries.length) html+=`<div class="expense-group"><div class="expense-group-title">Expensas ordinarias · a cargo del inquilino</div>${lines(ordEntries,'ordinary')}<div class="expense-line expense-subtotal"><span>Subtotal ordinarias</span><strong>${money(a.ordinary)}</strong></div></div>`;
      if(a.othersTenant>0) html+=`<div class="expense-group"><div class="expense-group-title">Otros</div><div class="expense-line"><span>${esc(pg.others?.tenant?.description||'Otros conceptos')}</span><strong>${money(a.othersTenant)}</strong></div></div>`;
    }else{
      const extEntries=Object.entries(pg?.expensesExtraordinary||{});
      if(extEntries.length) html+=`<div class="expense-group"><div class="expense-group-title">Descuentos · expensas extraordinarias</div>${lines(extEntries,'extraordinary')}<div class="expense-line expense-subtotal"><span>Total extraordinarias descontadas</span><strong>− ${money(a.extraordinary)}</strong></div></div>`;
      if(a.othersOwner>0) html+=`<div class="expense-group"><div class="expense-group-title">Otros descuentos</div><div class="expense-line"><span>${esc(pg.others?.owner?.description||'Otros descuentos')}</span><strong>− ${money(a.othersOwner)}</strong></div></div>`;
    }
    html+='</div>';return html;
  }
  function receiptMarkup(receipt){
    const pg=state.payments.find(p=>p.id===receipt.paymentId&&p.accountId===accountId()),prop=state.properties.find(p=>p.id===pg?.propertyId&&p.accountId===accountId());
    if(!pg)return `<div class="empty">El pago asociado al recibo no está disponible.</div>`;
    const para=receipt.para||'inquilino',dest=para==='propietario'?(pg.propietario||prop?.owner||'—'):(pg.inquilino||prop?.tenant||'—');
    pg.__receiptPara=para;const a=paymentAmounts(pg);
    return `<div id="printArea"><div class="receipt-card"><div class="receipt-head"><div><div class="receipt-brand">${esc(currentAccount()?.inmobiliaria||'Inmobiliaria')}</div><div class="receipt-sub">${para==='inquilino'?'Recibo de alquiler':'Liquidación al propietario'}</div></div><div class="receipt-number"><span>RECIBO</span><strong>${esc(receipt.numero)}</strong><small>${esc(pg.fecha||'')}</small></div></div>
    <div class="receipt-line"></div><div class="receipt-grid"><div><span>Propiedad</span><strong>${esc(prop?.title||'—')}</strong><small>${esc(prop?.address||'')}</small></div><div><span>Período</span><strong>${esc(pg.periodo||'—')}</strong></div><div><span>Destinatario</span><strong>${esc(dest)}</strong><small>${para==='inquilino'?'Inquilino':'Propietario'}</small></div><div><span>Método</span><strong>${esc(pg.metodo||'—')}</strong></div></div>
    ${expenseBreakdownHtml(pg)}
    ${expenseGrandTotalHtml(pg)}
    <div class="receipt-observation">${pg.notas?`Observaciones: ${esc(pg.notas)}`:'Pago correspondiente al período indicado.'}</div><div class="sign-row"><div>Firma inmobiliaria</div><div>Firma ${para==='inquilino'?'inquilino':'propietario'}</div></div><div class="receipt-foot">Comprobante interno · Emitido ${dateTime(receipt.generadoEl)}</div></div></div>`;
  }
  function paymentsReceiptsView(){
    const receipts=accountReceipts().sort((a,b)=>new Date(b.generadoEl)-new Date(a.generadoEl));
    return `<div class="panel"><div class="panel-head"><h3>Recibos generados automáticamente</h3><span class="muted">${receipts.length}</span></div>${receipts.length?receipts.map(r=>{const pg=state.payments.find(p=>p.id===r.paymentId),prop=state.properties.find(p=>p.id===pg?.propertyId);return `<div class="receipt-list-row"><div><strong>${esc(r.numero)}</strong><span>${esc(prop?.title||'—')} · ${esc(pg?.periodo||'—')}</span></div><strong>${money(pg?.monto)}</strong><div class="actions"><button class="btn btn-small" onclick="window.openReceipt('${r.id}')">Ver</button><button class="btn btn-small" onclick="window.withBusyButton(this,'Generando…',()=>window.downloadReceiptPDF('${r.id}'))">Descargar</button></div></div>`}).join(''):'<div class="empty">Los recibos aparecerán automáticamente al registrar pagos.</div>'}</div>`;
  }
  function openReceiptInternal(id){currentReceiptId=id;$('#modal')?.remove();const r=state.receipts.find(x=>x.id===id&&x.accountId===accountId());if(!r)return;document.body.insertAdjacentHTML('beforeend',`<div class="overlay open receipt-overlay" id="modal"><div class="receipt-drawer" role="dialog" aria-modal="true" aria-label="Recibo de pago"><button class="close" onclick="window.closeModal()">×</button><div class="receipt-toolbar"><select id="rc_para" onchange="window.renderReceiptPreview()"><option value="inquilino" ${r.para==='inquilino'?'selected':''}>Recibo para inquilino</option><option value="propietario" ${r.para==='propietario'?'selected':''}>Liquidación para propietario</option></select><div class="actions"><button class="btn" onclick="window.withBusyButton(this,'Generando…',()=>window.downloadReceiptPDF('${r.id}'))">Descargar</button><button class="btn btn-primary" onclick="window.print()">Imprimir / PDF</button></div></div><div id="receiptPreview">${receiptMarkup(r)}</div></div></div>`);}
  window.openReceipt=(receiptId,paymentId)=>{let r=receiptId?state.receipts.find(x=>x.id===receiptId&&x.accountId===accountId()):null;if(!r&&paymentId){const pg=state.payments.find(p=>p.id===paymentId&&p.accountId===accountId());if(pg){r=createReceiptForPayment(pg);saveState();}}if(r)openReceiptInternal(r.id);};
  window.renderReceiptPreview=()=>{const r=state.receipts.find(x=>x.id===currentReceiptId&&x.accountId===accountId());if(!r)return;const para=$('#rc_para')?.value||'inquilino';r.para=para;saveState();const box=$('#receiptPreview');if(box)box.innerHTML=receiptMarkup(r);};
  window.downloadReceiptPDF=receiptId=>{const r=state.receipts.find(x=>x.id===receiptId&&x.accountId===accountId());if(!r){toast('Recibo no encontrado.');return;}const jspdf=window.jspdf;if(!jspdf?.jsPDF){toast('El módulo PDF no está disponible. Verificá la conexión a internet.');return;}const pg=state.payments.find(p=>p.id===r.paymentId&&p.accountId===accountId()),prop=state.properties.find(p=>p.id===pg?.propertyId&&p.accountId===accountId());if(!pg)return;const para=r.para||'inquilino',dest=para==='propietario'?(pg.propietario||prop?.owner||'—'):(pg.inquilino||prop?.tenant||'—');const doc=new jspdf.jsPDF({unit:'mm',format:'a4'});const agency=currentAccount()?.inmobiliaria||'Inmobiliaria';doc.setFont('helvetica','bold');doc.setFontSize(18);doc.text(agency,20,25);doc.setFont('helvetica','normal');doc.setFontSize(10);doc.text('Comprobante de pago de alquiler',20,32);doc.setFont('helvetica','bold');doc.setFontSize(12);doc.text(`RECIBO ${r.numero}`,190,25,{align:'right'});doc.setFont('helvetica','normal');doc.text(pg.fecha||'',190,32,{align:'right'});doc.setDrawColor(40,40,40);doc.line(20,40,190,40);doc.setFont('helvetica','bold');doc.text('Propiedad',20,52);doc.text('Período',110,52);doc.setFont('helvetica','normal');doc.text(prop?.title||'—',20,59);doc.text(prop?.address||'',20,65);doc.text(pg.periodo||'—',110,59);doc.setFont('helvetica','bold');doc.text('Destinatario',20,79);doc.text('Método de pago',110,79);doc.setFont('helvetica','normal');doc.text(dest,20,86);doc.text(pg.metodo||'—',110,86);doc.setFillColor(244,239,226);doc.rect(20,98,170,20,'F');doc.setFont('helvetica','bold');doc.setFontSize(11);doc.text(para==='inquilino'?'TOTAL ABONADO':'TOTAL A LIQUIDAR',28,110);doc.setFontSize(18);doc.text(money(pg.monto),182,111,{align:'right'});doc.setFont('helvetica','normal');doc.setFontSize(10);let y=132;doc.text(pg.notas?`Observaciones: ${pg.notas}`:'Pago correspondiente al período indicado.',20,y,{maxWidth:170});y+=10;
    // Desglose coherente con la vista del recibo: ordinarias al inquilino,
    // extraordinarias y otros descuentos al propietario.
    const a=paymentAmounts(pg);
    doc.setFont('helvetica','bold');doc.setFontSize(10);doc.text('Alquiler',20,y);doc.text(money(a.rent),188,y,{align:'right'});y+=7;doc.setFont('helvetica','normal');
    const printGroup=(title,entries,negative=false)=>{doc.setFont('helvetica','bold');doc.text(title,20,y);y+=6;doc.setFont('helvetica','normal');entries.forEach(([k,v])=>{doc.text(expenseLabel(title.includes('ordinarias')?'ordinary':'extraordinary',k),22,y);doc.text((negative?'− ':'')+money(v),188,y,{align:'right'});y+=5.5;});y+=2;};
    if(para==='inquilino'){
      const ordEntries=Object.entries(pg.expensesOrdinary||{});if(ordEntries.length)printGroup('Expensas ordinarias',ordEntries,false);
      if(a.othersTenant>0){doc.setFont('helvetica','bold');doc.text('Otros',20,y);y+=6;doc.setFont('helvetica','normal');doc.text(pg.others?.tenant?.description||'Otros conceptos',22,y);doc.text(money(a.othersTenant),188,y,{align:'right'});y+=8;}
      doc.setFillColor(244,239,226);doc.rect(20,y-2,170,10,'F');doc.setFont('helvetica','bold');doc.text('TOTAL ABONADO',22,y+5);doc.text(money(a.tenantTotal),188,y+5,{align:'right'});y+=16;
    }else{
      const extEntries=Object.entries(pg.expensesExtraordinary||{});if(extEntries.length)printGroup('Descuentos extraordinarios',extEntries,true);
      if(a.othersOwner>0){doc.setFont('helvetica','bold');doc.text('Otros descuentos',20,y);y+=6;doc.setFont('helvetica','normal');doc.text(pg.others?.owner?.description||'Otros descuentos',22,y);doc.text('− '+money(a.othersOwner),188,y,{align:'right'});y+=8;}
      doc.setFillColor(244,239,226);doc.rect(20,y-2,170,10,'F');doc.setFont('helvetica','bold');doc.text('TOTAL A LIQUIDAR',22,y+5);doc.text(money(a.ownerTotal),188,y+5,{align:'right'});y+=16;
    }
    y=Math.max(y+8,170);
    doc.setDrawColor(120,120,120);doc.line(25,y,90,y);doc.line(120,y,185,y);doc.setFontSize(9);doc.text('Firma inmobiliaria',25,y+7);doc.text(para==='inquilino'?'Firma inquilino':'Firma propietario',120,y+7);doc.setFontSize(8);doc.text(`Comprobante interno · Emitido ${dateTime(r.generadoEl)}`,20,285);doc.save(`recibo_${safeName(r.numero)}.pdf`);recordAudit('RECEIPT_DOWNLOAD',`Descargado recibo ${r.numero}.`);};
  window.saveReceiptRecord=()=>{const r=state.receipts.find(x=>x.id===currentReceiptId&&x.accountId===accountId());if(!r)return;window.renderReceiptPreview();recordAudit('RECEIPT_UPDATE',`Recibo ${r.numero} actualizado`);toast('Recibo guardado.');};
  // El apartado se llama Pagos: reúne registro de pagos y recibos vinculados.
  function paymentsView(title){return paymentsBaseView(title)+paymentsReceiptsView();}

  function financeView(title){return `<div class="admin-head"><h2>${title}</h2></div><div class="panel"><div class="panel-head"><h3>Liquidación de alquiler</h3></div><div class="notice">Calculá cuánto corresponde a la inmobiliaria y cuánto recibe el propietario.</div><div class="grid-3"><div class="form-group"><label>Alquiler bruto</label><input id="grossRent" type="number" min="0" value="500000"></div><div class="form-group"><label>% inmobiliaria</label><input id="commPct" type="number" min="0" step="0.01" value="${Number(state.settings.commissionPercent)||5}"></div><div class="form-group"><label>Otros descuentos</label><input id="otherDed" type="number" min="0" value="0"></div></div><button class="btn btn-primary" onclick="window.calculateCommission()">Calcular liquidación</button><div id="commissionResult" class="result-space"></div></div>`;}
  window.calculateCommission=()=>{const gross=Number($('#grossRent')?.value)||0,pct=Number($('#commPct')?.value)||0,ded=Number($('#otherDed')?.value)||0;if(gross<0||pct<0||ded<0||pct>100){toast('Revisá los valores ingresados.');return;}const fee=gross*pct/100,owner=Math.max(0,gross-fee-ded);state.settings.commissionPercent=pct;saveState();$('#commissionResult').innerHTML=`<div class="calc-result"><div><span class="muted">Inmobiliaria (${pct}%)</span><div class="big">${money(fee)}</div></div><div><span class="muted">Propietario</span><div class="big">${money(owner)}</div></div></div><p class="muted">Bruto: ${money(gross)} · Descuentos: ${money(ded)}</p>`;recordAudit('COMMISSION_CALC',`Liquidación bruto ${money(gross)}, comisión ${pct}%`);};

  function securityView(title){
    const trash=state.trash.filter(t=>t.accountId===accountId());
    return `<div class="admin-head"><h2>${title}</h2><button class="btn btn-primary" onclick="window.createBackup()">Crear backup</button></div><div class="security-grid"><div class="security-item"><strong>Backup automático</strong><span>Se crea antes de operaciones críticas.</span></div><div class="security-item"><strong>Papelera 15 días</strong><span>Permite restaurar propiedades eliminadas.</span></div><div class="security-item"><strong>Auditoría</strong><span>Registra altas, cambios, pagos y errores.</span></div></div><div class="panel"><div class="panel-head"><h3>Papelera de reciclaje</h3><span class="muted">${trash.length} elemento(s)</span></div>${trash.length?trash.map(t=>`<div class="trash-card"><strong>${esc(t.snapshot?.title||'Elemento')}</strong><small>Eliminado: ${dateTime(t.deletedAt)}</small><div class="actions"><button class="btn btn-small" onclick="window.restoreTrash('${t.id}')">Restaurar</button><button class="btn btn-small btn-danger" onclick="window.destroyTrash('${t.id}')">Eliminar definitivamente</button></div></div>`).join(''):'<div class="empty">La papelera está vacía.</div>'}</div>`;
  }
  window.createBackup=()=>{snapshot('Backup manual');toast('Backup creado correctamente.');renderPanel();};
  window.restoreTrash=(id,silent=false)=>{const t=state.trash.find(x=>x.id===id&&x.accountId===accountId());if(!t)return;snapshot('Backup previo a restauración');if(t.snapshot){state.properties=state.properties.filter(p=>p.id!==t.snapshot.id);state.properties.push(t.snapshot);if(Array.isArray(t.linkedContracts)){state.contracts=state.contracts.filter(c=>c.propertyId!==t.snapshot.id);state.contracts.push(...t.linkedContracts);}}state.trash=state.trash.filter(x=>x.id!==id);recordAudit('RESTORE',`Restaurada propiedad ${t.snapshot?.title||'elemento'}`);saveState();if(!silent){renderPanel();toast('Propiedad restaurada.');}};
  window.destroyTrash=id=>{if(!confirm('Esta acción elimina definitivamente el elemento. ¿Continuar?'))return;const t=state.trash.find(x=>x.id===id&&x.accountId===accountId());if(!t)return;state.trash=state.trash.filter(x=>x.id!==id);(t.linkedContracts||[]).forEach(c=>{ if(c.fileName) idbDeleteFile(c.id); });recordAudit('PERMANENT_DELETE',`Eliminación definitiva: ${t.snapshot?.title||'elemento'}`,'warning');saveState();renderPanel();};

  function auditView(title){const logs=state.audit.filter(x=>x.accountId===accountId());return `<div class="admin-head"><h2>${title}</h2></div><div class="panel"><div class="notice">Registro de operaciones de la cuenta actual.</div>${logs.length?logs.slice(0,250).map(l=>`<div class="audit-row"><div class="time">${dateTime(l.at)}</div><div class="${l.level==='error'?'error':''}"><strong>${esc(l.action)}</strong><br>${esc(l.detail)}</div><div class="muted">${esc(l.level)}</div></div>`).join(''):'<div class="empty">No hay actividad registrada.</div>'}</div>`;}

  function rowsForExcel(){return accountProperties().map(p=>({ID:p.id,Propiedad:p.title,Dirección:p.address||'',Tipo:p.type||'Otro',Estado:p.status||'',Alquiler:p.rent||0,Inquilino:p.tenant||'',Teléfono_Inquilino:p.tenantPhone||'',Email_Inquilino:p.tenantEmail||'',Propietario:p.owner||'',Teléfono_Propietario:p.ownerPhone||'',Email_Propietario:p.ownerEmail||'',Notas:p.notes||'',Inicio_Contrato:p.contractStartDate||'',Dia_Cobro:p.rentDueDay||'',Tolerancia_Dias:p.rentToleranceDays||0}));}
  function paymentsForExcel(){return accountPayments().map(p=>{const prop=state.properties.find(x=>x.id===p.propertyId);return {ID:p.id,Propiedad:prop?.title||'',Periodo:p.periodo||'',Importe:p.monto||0,Fecha:p.fecha||'',Método:p.metodo||'',Inquilino:p.inquilino||'',Propietario:p.propietario||'',Notas:p.notas||''};});}
  function receiptsForExcel(){return accountReceipts().map(r=>{const p=state.payments.find(x=>x.id===r.paymentId),prop=state.properties.find(x=>x.id===p?.propertyId);return {Recibo:r.numero||'',Pago_ID:r.paymentId||'',Propiedad:prop?.title||'',Periodo:p?.periodo||'',Importe:p?.monto||0,Para:r.para||'',Generado:r.generadoEl||''};});}
  window.exportAllExcel=()=>{if(!window.XLSX){toast('No se pudo cargar el módulo Excel. Revisá tu conexión y recargá.');return;}const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rowsForExcel()),'Propiedades');XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(paymentsForExcel()),'Pagos');XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(receiptsForExcel()),'Recibos');XLSX.writeFile(wb,`panel_inmobiliario_${safeName(currentAccount().inmobiliaria)}_${fmtDateInput()}.xlsx`);recordAudit('FULL_EXPORT','Exportación completa Excel');};
  window.exportSelectedPropertiesExcel=()=>{if(!window.XLSX){toast('Módulo Excel no disponible.');return;}const selected=accountProperties().filter(p=>selectedPropertyIds.has(p.id));if(!selected.length){toast('Seleccioná al menos una propiedad.');return;}const rows=selected.map(p=>({Propiedad:p.title,Dirección:p.address||'',Tipo:p.type||'',Estado:p.status||'',Alquiler:p.rent||0,Inquilino:p.tenant||'',Email_Inquilino:p.tenantEmail||'',Propietario:p.owner||'',Email_Propietario:p.ownerEmail||'',Notas:p.notes||''}));const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),'Propiedades seleccionadas');XLSX.writeFile(wb,`propiedades_seleccionadas_${new Date().toISOString().slice(0,10)}.xlsx`);recordAudit('PROPERTY_EXPORT_SELECTED',`Exportadas ${selected.length} propiedad(es) seleccionada(s).`);};
  window.exportPropertyExcel=id=>{if(!window.XLSX){toast('Módulo Excel no disponible.');return;}const p=state.properties.find(x=>x.id===id&&x.accountId===accountId());if(!p)return;const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet([{Propiedad:p.title,Dirección:p.address||'',Tipo:p.type||'',Estado:p.status||'',Alquiler:p.rent||0,Propietario:p.owner||'',Teléfono_Propietario:p.ownerPhone||'',Email_Propietario:p.ownerEmail||'',Inquilino:p.tenant||'',Teléfono_Inquilino:p.tenantPhone||'',Email_Inquilino:p.tenantEmail||'',Notas:p.notes||'',Inicio_Contrato:p.contractStartDate||'',Dia_Cobro:p.rentDueDay||'',Tolerancia_Dias:p.rentToleranceDays||0}]),'Propiedad');XLSX.writeFile(wb,`propiedad_${safeName(p.title)}.xlsx`);};
  window.openImport=()=>{$('#modal')?.remove();document.body.insertAdjacentHTML('beforeend',`<div class="overlay open" id="modal"><div class="drawer" role="dialog" aria-modal="true" aria-label="Importar Excel"><button class="close" onclick="window.closeModal()">×</button><h3>Importar Excel</h3><div class="notice"><strong>Importación segura:</strong> se crea un backup antes de incorporar los datos.</div><div class="import-drop"><input id="importFile" type="file" accept=".xlsx,.xls"><p class="muted">El archivo debe contener una hoja llamada <strong>Propiedades</strong> o usar columnas Propiedad, Dirección, Tipo, Estado, Alquiler y Propietario.</p></div><div class="form-actions"><button class="btn btn-primary" onclick="window.withBusyButton(this,'Importando…',window.importExcel)">Validar e importar</button><button class="btn" onclick="window.closeModal()">Cancelar</button></div></div></div>`);};
  window.importExcel=()=>{const file=$('#importFile')?.files?.[0];if(!file){toast('Seleccioná un archivo Excel.');return;}if(!window.XLSX){toast('Módulo Excel no disponible.');return;}const reader=new FileReader();reader.onload=e=>{try{const wb=XLSX.read(new Uint8Array(e.target.result),{type:'array'}),ws=wb.Sheets[wb.SheetNames.includes('Propiedades')?'Propiedades':wb.SheetNames[0]];const rows=XLSX.utils.sheet_to_json(ws,{defval:''});if(!rows.length){toast('La hoja no contiene registros.');return;}snapshot('Backup previo a importación Excel');let count=0;for(const r of rows){const title=String(r.Propiedad??r.title??r.Nombre??'').trim();if(!title)continue;const type=PROPERTY_TYPES.includes(String(r.Tipo||''))?String(r.Tipo):'Otro';const status=PROPERTY_STATUS.includes(String(r.Estado||''))?String(r.Estado):'Disponible';state.properties.push({id:uid('imp'),accountId:accountId(),title,address:String(r.Dirección??r.address??''),type,status,rent:Math.max(0,Number(r.Alquiler)||0),owner:String(r.Propietario??r.owner??''),ownerPhone:String(r.Teléfono_Propietario??''),ownerEmail:String(r.Email_Propietario??''),tenant:String(r.Inquilino??''),tenantPhone:String(r.Teléfono_Inquilino??''),tenantEmail:String(r.Email_Inquilino??''),notes:String(r.Notas??''),contractStartDate:String(r.Inicio_Contrato??''),rentDueDay:Math.min(31,Math.max(0,Number(r.Dia_Cobro)||0))||null,rentToleranceDays:Math.min(31,Math.max(0,Number(r.Tolerancia_Dias)||0)),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});count++;}saveState();closeModal();recordAudit('IMPORT_EXCEL',`Importadas ${count} propiedades.`);toast(`Importación completada: ${count} propiedad(es).`);renderPanel();}catch(err){recordAudit('SYSTEM_ERROR','Error de importación Excel: '+err.message,'error');toast('No se pudo leer el archivo Excel.');}};reader.readAsArrayBuffer(file);};

  document.addEventListener('click',e=>{const overlay=e.target.closest?.('.overlay');if(overlay&&e.target===overlay)window.closeModal();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.querySelector('#modal'))window.closeModal();});

  window.addEventListener('error',e=>{try{if(e?.message==='Script error.'||(!e?.filename&&!e?.message))return;recordAudit('SYSTEM_ERROR',`Error JS: ${e.message||'desconocido'}`,'error');}catch(_){} });
  window.addEventListener('unhandledrejection',e=>{try{recordAudit('SYSTEM_ERROR',`Promesa rechazada: ${e.reason?.message||e.reason||'desconocido'}`,'error');}catch(_){} });

  // Migración de datos antiguos: si existían pagos con otra estructura, se conservan y se crean recibos.
  function migrateLegacyPayments(){
    let changed=false;
    state.properties.forEach(p=>{if(!p.type)p.type='Otro';if(!p.status)p.status='Disponible';if(p.rentToleranceDays==null)p.rentToleranceDays=5;if(!p.contractStartDate)p.contractStartDate='';if(p.rentDueDay===undefined)p.rentDueDay=null;if(p.accountId==null&&state.accounts.length===1)p.accountId=state.accounts[0].id;});
    if(Array.isArray(state.payments))state.payments.forEach(pg=>{if(!pg.accountId&&state.accounts.length===1){pg.accountId=state.accounts[0].id;changed=true;}if(!pg.id){pg.id=uid('pay');changed=true;}if(pg.accountId&&!state.receipts.some(r=>r.paymentId===pg.id)){createReceiptForPayment(pg);changed=true;}});
    state.contracts.forEach(c=>{if(!c.accountId&&state.accounts.length===1){c.accountId=state.accounts[0].id;changed=true;}});
    if(changed)saveState();
  }
  (async()=>{try{await fetchRemote();bootReady=true;migrateLegacyPayments();purgeTrash();render();}catch(e){if(e.status!==401)console.error('Sesión no disponible:',e);renderLogin(false);}})();
})();
