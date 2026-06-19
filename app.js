/* ============================================================
   教室予約管理システム - アプリケーションロジック v3
   追加機能：利用目的タグ / メモ欄 / 管理者モード / カレンダービュー
   ============================================================ */

'use strict';

// ============================================================
// 定数・設定
// ============================================================
const CONFIG_KEY       = 'classroom_firebase_url';
const OWNER_TOKEN_KEY  = 'classroom_owner_token';
const ADMIN_PW_HASH_KEY = 'classroom_admin_hash'; // 管理者PWハッシュ (SHA-256)
const DEFAULT_ADMIN_PW = 'admin1234'; // ← 初期パスワード（変更推奨）

const DURATION_OPTIONS = [
  { minutes: 30,  label: '30分' },
  { minutes: 60,  label: '1時間' },
  { minutes: 90,  label: '1時間30分' },
  { minutes: 120, label: '2時間' },
];

const PURPOSE_COLORS = {
  '授業': 'blue', '部活': 'green', '会議': 'purple',
  '自習': 'orange', 'イベント': 'pink', 'その他': 'gray',
};

const START_TIMES = (() => {
  const times = [];
  for (let h = 8; h <= 20; h++) {
    for (let m = 0; m < 60; m += 30) {
      if (h === 20 && m > 0) break;
      times.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
    }
  }
  return times;
})();

// カレンダーの表示時間帯（8:00〜20:00）
const CAL_START_HOUR = 8;
const CAL_END_HOUR   = 20;
const SLOT_HEIGHT_PX = 48; // 30分 = 48px

// ============================================================
// 状態管理
// ============================================================
let bookings         = [];
let selectedDuration = null;
let selectedTag      = null;   // 利用目的タグ
let pendingDeleteId  = null;
let firebaseUrl      = null;
let eventSource      = null;
let isAdmin          = false;  // 管理者ログイン中
let calWeekOffset    = 0;      // カレンダー週オフセット（0=今週）

// ============================================================
// DOM 参照
// ============================================================
const $ = (id) => document.getElementById(id);

const DOM = {
  setupOverlay:    $('setup-overlay'),
  setupUrl:        $('setup-url'),
  setupTest:       $('setup-test'),
  setupSave:       $('setup-save'),
  setupTestResult: $('setup-test-result'),
  setupChangeBtn:  $('setup-change-btn'),
  connStatus:      $('conn-status'),
  totalCount:      $('total-count'),
  adminBar:        $('admin-bar'),
  adminLoginBtn:   $('admin-login-btn'),
  adminOverlay:    $('admin-overlay'),
  adminPassword:   $('admin-password'),
  adminError:      $('admin-error'),
  adminCancel:     $('admin-cancel'),
  adminConfirm:    $('admin-confirm'),
  adminDeleteAll:  $('admin-delete-all'),
  adminLogout:     $('admin-logout'),
  viewTabs:        document.querySelectorAll('.view-tab'),
  viewList:        $('view-list'),
  viewCalendar:    $('view-calendar'),
  form:            $('booking-form'),
  nameInput:       $('classroom-name'),
  dateInput:       $('booking-date'),
  startSelect:     $('start-time'),
  durationBtns:    document.querySelectorAll('.duration-btn'),
  tagBtns:         document.querySelectorAll('.tag-btn'),
  memoInput:       $('booking-memo'),
  submitBtn:       $('submit-btn'),
  timePreview:     $('time-preview'),
  previewTime:     $('preview-time'),
  bookingList:     $('booking-list'),
  emptyState:      $('empty-state'),
  searchInput:     $('search-input'),
  toastContainer:  $('toast-container'),
  modalOverlay:    $('modal-overlay'),
  modalDesc:       $('modal-desc'),
  modalCancel:     $('modal-cancel'),
  modalConfirm:    $('modal-confirm'),
  nameError:       $('name-error'),
  dateError:       $('date-error'),
  startError:      $('start-error'),
  durationError:   $('duration-error'),
  calGrid:         $('calendar-grid'),
  calRange:        $('cal-range'),
  calPrev:         $('cal-prev'),
  calNext:         $('cal-next'),
  calToday:        $('cal-today'),
};

// ============================================================
// ユーティリティ
// ============================================================
function minutesToHHMM(total) {
  return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`;
}
function calcEndTime(startTime, durationMinutes) {
  const [h,m] = startTime.split(':').map(Number);
  return minutesToHHMM(h*60+m+durationMinutes);
}
function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2,9)}`;
}
function formatDateJP(dateStr) {
  const d = new Date(dateStr+'T00:00:00');
  const days = ['日','月','火','水','木','金','土'];
  return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日(${days[d.getDay()]})`;
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function dateToStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function normalizeUrl(url) { return url.trim().replace(/\/+$/,''); }

// SHA-256 ハッシュ（管理者パスワード照合用）
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

// ============================================================
// ブラウザトークン（予約者識別）
// ============================================================
function getOwnerToken() {
  let token = localStorage.getItem(OWNER_TOKEN_KEY);
  if (!token) {
    token = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(OWNER_TOKEN_KEY, token);
  }
  return token;
}

// ============================================================
// Firebase 設定管理
// ============================================================
function getSavedUrl() { try { return localStorage.getItem(CONFIG_KEY)||null; } catch { return null; } }
function saveUrl(url)  { localStorage.setItem(CONFIG_KEY, url); }

// ============================================================
// Firebase REST API
// ============================================================
async function fbGetAll() {
  const res = await fetch(`${firebaseUrl}/bookings.json`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data) return [];
  return Object.entries(data).map(([key,val])=>({...val,_key:key}));
}
async function fbAdd(booking) {
  const res = await fetch(`${firebaseUrl}/bookings.json`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(booking)});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function fbDelete(key) {
  const res = await fetch(`${firebaseUrl}/bookings/${key}.json`,{method:'DELETE'});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
async function fbTest(url) {
  const res = await fetch(`${url}/bookings.json?shallow=true`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return true;
}

// ============================================================
// SSE リアルタイム同期
// ============================================================
function subscribeRealtime() {
  if (eventSource) { eventSource.close(); eventSource=null; }
  updateConnectionStatus('connecting');
  const es = new EventSource(`${firebaseUrl}/bookings.json`);
  eventSource = es;

  es.addEventListener('put', (e) => {
    try {
      const {path, data} = JSON.parse(e.data);
      if (path === '/') {
        bookings = data ? Object.entries(data).map(([k,v])=>({...v,_key:k})) : [];
      } else {
        const key = path.replace(/^\//,'');
        if (data === null) { bookings = bookings.filter(b=>b._key!==key); }
        else {
          const exists = bookings.find(b=>b._key===key);
          if (!exists) bookings.push({...data,_key:key});
        }
      }
      renderList(); renderCalendar(); updateTotalCount();
      updateConnectionStatus('connected');
    } catch(err) { console.error('[SSE put]',err); }
  });

  es.addEventListener('patch', (e) => {
    try {
      const {data} = JSON.parse(e.data);
      if (!data) return;
      Object.entries(data).forEach(([key,val])=>{
        if (val===null) { bookings=bookings.filter(b=>b._key!==key); }
        else {
          const idx=bookings.findIndex(b=>b._key===key);
          if (idx>=0) bookings[idx]={...val,_key:key}; else bookings.push({...val,_key:key});
        }
      });
      renderList(); renderCalendar(); updateTotalCount();
    } catch(err) { console.error('[SSE patch]',err); }
  });

  es.onerror = () => {
    updateConnectionStatus('error');
    setTimeout(()=>{ if(firebaseUrl) subscribeRealtime(); }, 5000);
  };
}

function updateConnectionStatus(status) {
  const labels = { connecting:'⏳ 接続中', connected:'🟢 リアルタイム同期中', error:'🔴 接続エラー' };
  DOM.connStatus.className = `conn-status conn-status--${status}`;
  DOM.connStatus.textContent = labels[status]??'';
}

// ============================================================
// セットアップ画面
// ============================================================
function showSetup() {
  const saved=getSavedUrl(); if(saved) DOM.setupUrl.value=saved;
  DOM.setupOverlay.hidden=false; DOM.setupUrl.focus();
}
function hideSetup() {
  DOM.setupOverlay.hidden=true;
  DOM.setupTestResult.textContent=''; DOM.setupTestResult.className='setup-result';
}
function setSetupResult(msg,type) { DOM.setupTestResult.textContent=msg; DOM.setupTestResult.className=`setup-result setup-result--${type}`; }

async function handleTestConnection() {
  const url=normalizeUrl(DOM.setupUrl.value); if(!url){setSetupResult('URLを入力してください','error');return;}
  DOM.setupTest.disabled=true; DOM.setupTest.textContent='テスト中…'; setSetupResult('','');
  try { await fbTest(url); setSetupResult('✅ 接続成功！「保存して接続」を押してください','success'); }
  catch { setSetupResult('❌ 接続失敗。URLと権限設定を確認してください','error'); }
  finally { DOM.setupTest.disabled=false; DOM.setupTest.textContent='接続テスト'; }
}

async function handleSaveConfig() {
  const url=normalizeUrl(DOM.setupUrl.value); if(!url){setSetupResult('URLを入力してください','error');return;}
  DOM.setupSave.disabled=true; DOM.setupSave.textContent='接続中…'; setSetupResult('','');
  try {
    await fbTest(url); saveUrl(url); firebaseUrl=url; hideSetup(); subscribeRealtime();
    showToast('🔥 Firebase に接続しました。全利用者で同期中！','success');
  } catch { setSetupResult('❌ 接続できません。URLと Realtime Database の設定を確認してください','error'); }
  finally { DOM.setupSave.disabled=false; DOM.setupSave.textContent='保存して接続'; }
}

// ============================================================
// 管理者モード
// ============================================================
function showAdminModal() {
  DOM.adminPassword.value=''; DOM.adminError.textContent=''; DOM.adminError.classList.remove('visible');
  DOM.adminOverlay.hidden=false; DOM.adminPassword.focus();
}
function hideAdminModal() { DOM.adminOverlay.hidden=true; }

async function handleAdminLogin() {
  const pw = DOM.adminPassword.value;
  if (!pw) { showAdminError('パスワードを入力してください'); return; }
  const hash = await sha256(pw);
  const savedHash = localStorage.getItem(ADMIN_PW_HASH_KEY) || await sha256(DEFAULT_ADMIN_PW);
  if (!localStorage.getItem(ADMIN_PW_HASH_KEY)) {
    // 初回：デフォルトPWのハッシュを保存
    localStorage.setItem(ADMIN_PW_HASH_KEY, await sha256(DEFAULT_ADMIN_PW));
  }
  if (hash === savedHash) {
    isAdmin = true;
    DOM.adminBar.hidden = false;
    hideAdminModal();
    showToast('🔑 管理者モードで入りました', 'success');
  } else {
    showAdminError('パスワードが違います');
  }
}

function showAdminError(msg) {
  DOM.adminError.textContent=`⚠ ${msg}`; DOM.adminError.classList.add('visible');
}

function handleAdminLogout() {
  isAdmin=false; DOM.adminBar.hidden=true;
  showToast('ログアウトしました','warning');
  renderList();
}

async function handleAdminDeleteAll() {
  if (!confirm('全ての予約を削除しますか？この操作は元に戻せません。')) return;
  try {
    // Firebase の /bookings を丸ごと削除
    await fetch(`${firebaseUrl}/bookings.json`,{method:'DELETE'});
    showToast('🗑 全予約を削除しました','warning');
  } catch(err) { console.error(err); showToast('❌ 削除に失敗しました','error'); }
}

// ============================================================
// ビュー切り替え（タブ）
// ============================================================
function switchView(viewName) {
  DOM.viewTabs.forEach(tab=>{
    const isActive=tab.dataset.view===viewName;
    tab.classList.toggle('active',isActive);
    tab.setAttribute('aria-selected',isActive);
  });
  DOM.viewList.hidden    = viewName!=='list';
  DOM.viewCalendar.hidden= viewName!=='calendar';
  if (viewName==='calendar') renderCalendar();
}

// ============================================================
// 初期化
// ============================================================
function init() {
  // 開始時刻の選択肢を生成
  START_TIMES.forEach(t=>{
    const opt=document.createElement('option'); opt.value=t; opt.textContent=t;
    DOM.startSelect.appendChild(opt);
  });
  DOM.dateInput.value=todayStr(); DOM.dateInput.min=todayStr();

  // 教室名：小文字→大文字
  DOM.nameInput.addEventListener('input',()=>{
    const el=DOM.nameInput,s=el.selectionStart,end=el.selectionEnd;
    const u=el.value.replace(/[a-z]/g,c=>c.toUpperCase());
    if(el.value!==u){el.value=u;el.setSelectionRange(s,end);}
  });

  // フォーム
  DOM.form.addEventListener('submit', handleSubmit);
  DOM.durationBtns.forEach(btn=>btn.addEventListener('click',()=>handleDurationSelect(Number(btn.dataset.minutes))));
  DOM.tagBtns.forEach(btn=>btn.addEventListener('click',()=>handleTagSelect(btn.dataset.tag, btn.dataset.color)));
  DOM.startSelect.addEventListener('change', updateTimePreview);
  DOM.searchInput.addEventListener('input', renderList);

  // 削除モーダル
  DOM.modalCancel.addEventListener('click', closeModal);
  DOM.modalConfirm.addEventListener('click', handleDeleteConfirm);
  DOM.modalOverlay.addEventListener('click',e=>{if(e.target===DOM.modalOverlay)closeModal();});

  // セットアップ
  DOM.setupTest.addEventListener('click', handleTestConnection);
  DOM.setupSave.addEventListener('click', handleSaveConfig);
  DOM.setupChangeBtn.addEventListener('click', showSetup);

  // 管理者
  DOM.adminLoginBtn.addEventListener('click', showAdminModal);
  DOM.adminCancel.addEventListener('click', hideAdminModal);
  DOM.adminConfirm.addEventListener('click', handleAdminLogin);
  DOM.adminPassword.addEventListener('keydown',e=>{if(e.key==='Enter')handleAdminLogin();});
  DOM.adminDeleteAll.addEventListener('click', handleAdminDeleteAll);
  DOM.adminLogout.addEventListener('click', handleAdminLogout);
  DOM.adminOverlay.addEventListener('click',e=>{if(e.target===DOM.adminOverlay)hideAdminModal();});

  // タブ切り替え
  DOM.viewTabs.forEach(tab=>tab.addEventListener('click',()=>switchView(tab.dataset.view)));

  // カレンダーナビ
  DOM.calPrev.addEventListener('click',()=>{calWeekOffset--;renderCalendar();});
  DOM.calNext.addEventListener('click',()=>{calWeekOffset++;renderCalendar();});
  DOM.calToday.addEventListener('click',()=>{calWeekOffset=0;renderCalendar();});

  // ESCキー
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){
      if(!DOM.modalOverlay.hidden)closeModal();
      else if(!DOM.adminOverlay.hidden)hideAdminModal();
      else if(!DOM.setupOverlay.hidden&&firebaseUrl)hideSetup();
    }
  });

  // Firebase 接続
  const saved=getSavedUrl();
  if (saved) { firebaseUrl=saved; hideSetup(); subscribeRealtime(); }
  else showSetup();

  renderList(); updateTotalCount();
}

// ============================================================
// 利用時間の選択
// ============================================================
function handleDurationSelect(minutes) {
  selectedDuration=minutes;
  DOM.durationBtns.forEach(btn=>btn.classList.toggle('active',Number(btn.dataset.minutes)===minutes));
  clearError(DOM.durationError); updateTimePreview();
}

// ============================================================
// 利用目的タグの選択
// ============================================================
function handleTagSelect(tag, color) {
  if (selectedTag===tag) {
    selectedTag=null;
    DOM.tagBtns.forEach(btn=>btn.classList.remove('active'));
  } else {
    selectedTag=tag;
    DOM.tagBtns.forEach(btn=>btn.classList.toggle('active',btn.dataset.tag===tag));
  }
}

// ============================================================
// 時間プレビュー更新
// ============================================================
function updateTimePreview() {
  const st=DOM.startSelect.value;
  if(st&&selectedDuration){
    DOM.previewTime.textContent=`${st} ～ ${calcEndTime(st,selectedDuration)}`;
    DOM.timePreview.classList.add('has-time');
  } else {
    DOM.previewTime.textContent='──:── ～ ──:──';
    DOM.timePreview.classList.remove('has-time');
  }
}

// ============================================================
// バリデーション
// ============================================================
function showError(el,msg){el.textContent=`⚠ ${msg}`;el.classList.add('visible');}
function clearError(el){el.textContent='';el.classList.remove('visible');}
function clearAllErrors(){
  [DOM.nameError,DOM.dateError,DOM.startError,DOM.durationError].forEach(clearError);
  [DOM.nameInput,DOM.dateInput,DOM.startSelect].forEach(el=>el.classList.remove('error'));
}

function validate() {
  clearAllErrors(); let valid=true;
  const name=DOM.nameInput.value.trim(), date=DOM.dateInput.value, st=DOM.startSelect.value;
  if(!name){showError(DOM.nameError,'教室名を入力してください');DOM.nameInput.classList.add('error');valid=false;}
  if(!date){showError(DOM.dateError,'予約日を選択してください');DOM.dateInput.classList.add('error');valid=false;}
  if(!st){showError(DOM.startError,'開始時刻を選択してください');DOM.startSelect.classList.add('error');valid=false;}
  if(!selectedDuration){showError(DOM.durationError,'利用時間を選択してください');valid=false;}
  if(valid){
    const dup=bookings.find(b=>b.name===name&&b.date===date);
    if(dup){showError(DOM.nameError,`「${name}」は ${formatDateJP(date)} に既に予約が入っています`);DOM.nameInput.classList.add('error');valid=false;}
  }
  return valid;
}

// ============================================================
// フォーム送信（予約追加）
// ============================================================
async function handleSubmit(e) {
  e.preventDefault(); if(!validate())return;
  if(!firebaseUrl){showToast('❌ Firebase 未接続です','error');showSetup();return;}
  DOM.submitBtn.disabled=true;

  const name=DOM.nameInput.value.trim(), date=DOM.dateInput.value;
  const startTime=DOM.startSelect.value, endTime=calcEndTime(startTime,selectedDuration);
  const durationLabel=DURATION_OPTIONS.find(o=>o.minutes===selectedDuration)?.label??'';
  const tagColor = selectedTag ? (PURPOSE_COLORS[selectedTag]??'gray') : '';

  const newBooking = {
    id: generateId(), name, date, startTime, endTime,
    durationMinutes: selectedDuration, durationLabel,
    purpose: selectedTag??'', purposeColor: tagColor,
    memo: DOM.memoInput.value.trim(),
    createdAt: new Date().toISOString(),
    ownerToken: getOwnerToken(),
  };

  try {
    await fbAdd(newBooking); resetForm();
    showToast(`✅ 「${name}」の予約を追加しました`,'success'); animateSubmitBtn();
  } catch(err) { console.error(err); showToast('❌ 予約の追加に失敗しました','error'); }
  finally { DOM.submitBtn.disabled=false; }
}

function resetForm() {
  DOM.nameInput.value=''; DOM.dateInput.value=todayStr();
  DOM.startSelect.value=''; DOM.memoInput.value='';
  selectedDuration=null; selectedTag=null;
  DOM.durationBtns.forEach(btn=>btn.classList.remove('active'));
  DOM.tagBtns.forEach(btn=>btn.classList.remove('active'));
  DOM.previewTime.textContent='──:── ～ ──:──';
  DOM.timePreview.classList.remove('has-time'); clearAllErrors();
}

function animateSubmitBtn() {
  const ripple=DOM.submitBtn.querySelector('.btn-ripple');
  ripple.classList.remove('animate'); void ripple.offsetWidth; ripple.classList.add('animate');
}

// ============================================================
// 予約一覧レンダリング
// ============================================================
function renderList() {
  const query=DOM.searchInput.value.trim().toLowerCase();
  const filtered=bookings
    .filter(b=>b.name.toLowerCase().includes(query)||(b.purpose&&b.purpose.toLowerCase().includes(query)))
    .sort((a,b)=>{ const dc=a.date.localeCompare(b.date); return dc!==0?dc:a.startTime.localeCompare(b.startTime); });

  DOM.emptyState.style.display=filtered.length===0?'flex':'none';
  DOM.bookingList.querySelectorAll('.booking-item').forEach(el=>el.remove());
  filtered.forEach((booking,i)=>DOM.bookingList.appendChild(createBookingItem(booking,i)));
}

function createBookingItem(booking, index) {
  const item=document.createElement('div');
  item.className='booking-item'; item.setAttribute('role','listitem');
  item.dataset.id=booking.id; item.dataset.key=booking._key??'';
  item.dataset.color=booking.purposeColor??'';
  item.style.animationDelay=`${index*40}ms`;

  const isOwner=booking.ownerToken&&booking.ownerToken===getOwnerToken();
  const canDelete=isOwner||isAdmin;

  const purposeTag=booking.purpose
    ? `<span class="booking-purpose-tag" data-color="${escapeHtml(booking.purposeColor)}">${escapeHtml(booking.purpose)}</span>` : '';
  const ownerBadge=isOwner?`<span class="owner-tag">✏ 自分の予約</span>`:'';
  const memoLine=booking.memo?`<div class="booking-memo">📝 ${escapeHtml(booking.memo)}</div>`:'';
  const deleteBtn=canDelete
    ? `<button class="delete-btn" aria-label="${escapeHtml(booking.name)}の予約を削除" data-id="${booking.id}" title="削除">🗑</button>`
    : `<div class="delete-placeholder"></div>`;

  item.innerHTML=`
    <div class="booking-icon">🏫</div>
    <div class="booking-info">
      <div class="booking-name">${escapeHtml(booking.name)}</div>
      <div class="booking-meta">
        <span class="booking-date">📅 ${formatDateJP(booking.date)}</span>
        <span class="booking-time">${booking.startTime} ～ ${booking.endTime}</span>
        <span class="booking-duration-tag">⏱ ${booking.durationLabel}</span>
        ${purposeTag}${ownerBadge}
      </div>
      ${memoLine}
    </div>
    ${deleteBtn}
  `;

  if (canDelete) item.querySelector('.delete-btn').addEventListener('click',()=>openModal(booking));
  return item;
}

// ============================================================
// 件数更新
// ============================================================
function updateTotalCount() { DOM.totalCount.textContent=bookings.length; }

// ============================================================
// 削除モーダル
// ============================================================
function openModal(booking) {
  pendingDeleteId=booking.id;
  DOM.modalDesc.innerHTML=`<strong>${escapeHtml(booking.name)}</strong> の予約<br>${formatDateJP(booking.date)}<br>${booking.startTime} ～ ${booking.endTime}（${booking.durationLabel}）<br><br>この操作は元に戻せません。`;
  DOM.modalOverlay.hidden=false; DOM.modalConfirm.focus();
}
function closeModal() { DOM.modalOverlay.hidden=true; pendingDeleteId=null; }

async function handleDeleteConfirm() {
  if(!pendingDeleteId)return;
  const idToDelete=pendingDeleteId;
  const bookingToDelete=bookings.find(b=>b.id===idToDelete);
  closeModal();
  if(!bookingToDelete||!bookingToDelete._key){showToast('❌ 削除対象が見つかりません','error');return;}

  const itemEl=DOM.bookingList.querySelector(`[data-id="${idToDelete}"]`);
  if(itemEl){ itemEl.classList.add('removing'); await new Promise(r=>setTimeout(r,280)); itemEl.remove(); }

  bookings=bookings.filter(b=>b.id!==idToDelete); updateTotalCount();
  const vis=DOM.bookingList.querySelectorAll('.booking-item');
  DOM.emptyState.style.display=vis.length===0?'flex':'none';

  try {
    await fbDelete(bookingToDelete._key);
    showToast(`🗑 「${bookingToDelete.name}」の予約を削除しました`,'warning');
  } catch(err) { console.error(err); showToast('❌ 削除に失敗しました','error'); }
}

// ============================================================
// カレンダービュー
// ============================================================
function getWeekDates(offset=0) {
  const today=new Date(); today.setHours(0,0,0,0);
  const dow=today.getDay(); // 0=日
  const monday=new Date(today); monday.setDate(today.getDate()-dow+1+(offset*7));
  return Array.from({length:7},(_,i)=>{ const d=new Date(monday); d.setDate(monday.getDate()+i); return d; });
}

function renderCalendar() {
  const days=getWeekDates(calWeekOffset);
  const todayStr_=todayStr();

  // レンジ表示
  const fmt=d=>`${d.getMonth()+1}/${d.getDate()}`;
  DOM.calRange.textContent=`${fmt(days[0])}（月）〜 ${fmt(days[6])}（日）`;

  // グリッドをリセット
  DOM.calGrid.innerHTML='';

  // 時刻ラベル列のヘッダー
  const cornerEl=document.createElement('div');
  cornerEl.className='cal-day-header';
  cornerEl.style.cssText='border-right:1px solid var(--clr-border)';
  DOM.calGrid.appendChild(cornerEl);

  // 曜日ヘッダー
  const dayNames=['月','火','水','木','金','土','日'];
  days.forEach((d,i)=>{
    const el=document.createElement('div');
    const isToday=dateToStr(d)===todayStr_;
    el.className='cal-day-header'+(isToday?' today':'');
    el.innerHTML=`${dayNames[i]}<span>${d.getDate()}</span>`;
    DOM.calGrid.appendChild(el);
  });

  // 時刻ラベル + セル
  const slots=(CAL_END_HOUR-CAL_START_HOUR)*2;
  for(let slot=0;slot<slots;slot++){
    const hour=CAL_START_HOUR+Math.floor(slot/2);
    const min=slot%2===0?'00':'30';
    const timeLabel=document.createElement('div');
    timeLabel.className='cal-time-col cal-time-label';
    timeLabel.textContent=slot%2===0?`${String(hour).padStart(2,'0')}:00`:'';
    DOM.calGrid.appendChild(timeLabel);

    days.forEach(d=>{
      const cell=document.createElement('div');
      const isToday=dateToStr(d)===todayStr_;
      cell.className='cal-cell'+(isToday?' today-col':'');
      DOM.calGrid.appendChild(cell);
    });
  }

  // 予約イベントを配置
  const dayMap={};
  days.forEach(d=>{ dayMap[dateToStr(d)]=d; });

  bookings.forEach(b=>{
    if(!dayMap[b.date])return;
    const colIndex=days.findIndex(d=>dateToStr(d)===b.date);
    if(colIndex<0)return;

    const [sh,sm]=b.startTime.split(':').map(Number);
    const startSlot=(sh-CAL_START_HOUR)*2+(sm>=30?1:0);
    if(startSlot<0||startSlot>=slots)return;

    const durationSlots=Math.ceil(b.durationMinutes/30);
    const heightPx=durationSlots*SLOT_HEIGHT_PX-4;
    const topPx=startSlot*SLOT_HEIGHT_PX+2;

    // セルを探してイベント要素を追加
    // グリッドのセル位置：先頭行（ヘッダー 8列）+ 各行は 8列目（時刻1 + 曜日7）
    // slot行のcolIndex+1番目のセル
    const headerCount=8; // corner + 7 day headers
    const cellIndex=headerCount + slot*8 + (colIndex+1);
    const targetCell=DOM.calGrid.children[cellIndex];
    if(!targetCell)return;

    const ev=document.createElement('div');
    ev.className='cal-event';
    ev.dataset.color=b.purposeColor??'';
    ev.style.cssText=`top:${topPx}px;height:${heightPx}px`;
    ev.textContent=`${b.startTime} ${b.name}`;
    ev.title=`${b.name}\n${b.startTime}〜${b.endTime}\n${b.purpose||''}\n${b.memo||''}`;
    targetCell.appendChild(ev);
  });
}

// ============================================================
// トースト通知
// ============================================================
function showToast(message, type='success', duration=3500) {
  const toast=document.createElement('div');
  toast.className=`toast ${type}`; toast.textContent=message;
  DOM.toastContainer.appendChild(toast);
  setTimeout(()=>{
    toast.classList.add('hiding');
    toast.addEventListener('animationend',()=>toast.remove(),{once:true});
  },duration);
}

// ============================================================
// アプリ起動
// ============================================================
document.addEventListener('DOMContentLoaded', init);
