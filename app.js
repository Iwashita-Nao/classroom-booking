/* ============================================================
   教室予約管理システム - アプリケーションロジック
   Firebase Realtime Database によるリアルタイム共有対応版
   ============================================================ */

'use strict';

// ============================================================
// 定数・設定
// ============================================================
const CONFIG_KEY = 'classroom_firebase_url';

const DURATION_OPTIONS = [
  { minutes: 30,  label: '30分' },
  { minutes: 60,  label: '1時間' },
  { minutes: 90,  label: '1時間30分' },
  { minutes: 120, label: '2時間' },
];

// 開始時刻の選択肢（8:00〜20:00 を30分刻み）
const START_TIMES = (() => {
  const times = [];
  for (let h = 8; h <= 20; h++) {
    for (let m = 0; m < 60; m += 30) {
      if (h === 20 && m > 0) break;
      times.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return times;
})();

// ============================================================
// 状態管理
// ============================================================
let bookings      = [];    // { id, name, date, startTime, endTime, durationMinutes, durationLabel, _key }
let selectedDuration = null;
let pendingDeleteId  = null;  // 削除確認待ちの予約 ID
let firebaseUrl   = null;  // Firebase DB URL
let eventSource   = null;  // SSE 接続

// ============================================================
// DOM 要素の参照
// ============================================================
const $ = (id) => document.getElementById(id);

const DOM = {
  // Setup overlay
  setupOverlay:    $('setup-overlay'),
  setupUrl:        $('setup-url'),
  setupTest:       $('setup-test'),
  setupSave:       $('setup-save'),
  setupTestResult: $('setup-test-result'),
  setupChangeBtn:  $('setup-change-btn'),
  // Header
  connStatus:      $('conn-status'),
  totalCount:      $('total-count'),
  // Form
  form:            $('booking-form'),
  nameInput:       $('classroom-name'),
  dateInput:       $('booking-date'),
  startSelect:     $('start-time'),
  durationBtns:    document.querySelectorAll('.duration-btn'),
  submitBtn:       $('submit-btn'),
  timePreview:     $('time-preview'),
  previewTime:     $('preview-time'),
  // List
  bookingList:     $('booking-list'),
  emptyState:      $('empty-state'),
  searchInput:     $('search-input'),
  // Toast
  toastContainer:  $('toast-container'),
  // Modal
  modalOverlay:    $('modal-overlay'),
  modalDesc:       $('modal-desc'),
  modalCancel:     $('modal-cancel'),
  modalConfirm:    $('modal-confirm'),
  // Errors
  nameError:       $('name-error'),
  dateError:       $('date-error'),
  startError:      $('start-error'),
  durationError:   $('duration-error'),
};

// ============================================================
// ユーティリティ関数
// ============================================================

function minutesToHHMM(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function calcEndTime(startTime, durationMinutes) {
  const [h, m] = startTime.split(':').map(Number);
  return minutesToHHMM(h * 60 + m + durationMinutes);
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatDateJP(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${days[d.getDay()]})`;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function normalizeUrl(url) {
  return url.trim().replace(/\/+$/, '');
}

// ============================================================
// Firebase 設定管理（localStorage に URL を保存）
// ============================================================

function getSavedUrl() {
  try { return localStorage.getItem(CONFIG_KEY) || null; }
  catch { return null; }
}

function saveUrl(url) {
  localStorage.setItem(CONFIG_KEY, url);
}

// ============================================================
// Firebase REST API
// ============================================================

/**
 * 全予約を一度取得する
 */
async function fbGetAll() {
  const res = await fetch(`${firebaseUrl}/bookings.json`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data) return [];
  return Object.entries(data).map(([key, val]) => ({ ...val, _key: key }));
}

/**
 * 予約を追加する（Firebase の POST は自動キーを生成）
 */
async function fbAdd(booking) {
  const res = await fetch(`${firebaseUrl}/bookings.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(booking),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json(); // { name: "-autoKey" }
}

/**
 * 特定の予約を削除する
 */
async function fbDelete(firebaseKey) {
  const res = await fetch(`${firebaseUrl}/bookings/${firebaseKey}.json`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/**
 * 接続テスト（shallow=true で最低限のデータのみ取得）
 */
async function fbTest(url) {
  const res = await fetch(`${url}/bookings.json?shallow=true`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return true;
}

// ============================================================
// Firebase SSE（Server-Sent Events）でリアルタイム同期
// ============================================================

function subscribeRealtime() {
  if (eventSource) { eventSource.close(); eventSource = null; }

  updateConnectionStatus('connecting');

  const es = new EventSource(`${firebaseUrl}/bookings.json`);
  eventSource = es;

  // put: パス全体または特定キーのデータが置き換えられた
  es.addEventListener('put', (e) => {
    try {
      const payload = JSON.parse(e.data);
      const path = payload.path;   // '/' or '/-keyABC'
      const data = payload.data;

      if (path === '/') {
        // 初回ロードまたは全体置き換え
        bookings = data
          ? Object.entries(data).map(([k, v]) => ({ ...v, _key: k }))
          : [];
      } else {
        // 特定キーへの put（追加 or 削除）
        const key = path.replace(/^\//, '');
        if (data === null) {
          // 削除イベント → ローカルにまだ残っていれば取り除く
          bookings = bookings.filter((b) => b._key !== key);
        } else {
          // 追加イベント → 重複なく追加
          const exists = bookings.find((b) => b._key === key);
          if (!exists) {
            bookings.push({ ...data, _key: key });
          }
        }
      }

      renderList();
      updateTotalCount();
      updateConnectionStatus('connected');
    } catch (err) {
      console.error('[SSE put]', err);
    }
  });

  // patch: 部分的な更新（バッチ書き込み時など）
  es.addEventListener('patch', (e) => {
    try {
      const payload = JSON.parse(e.data);
      const data = payload.data;
      if (!data) return;
      Object.entries(data).forEach(([key, val]) => {
        if (val === null) {
          bookings = bookings.filter((b) => b._key !== key);
        } else {
          const idx = bookings.findIndex((b) => b._key === key);
          if (idx >= 0) { bookings[idx] = { ...val, _key: key }; }
          else          { bookings.push({ ...val, _key: key }); }
        }
      });
      renderList();
      updateTotalCount();
    } catch (err) {
      console.error('[SSE patch]', err);
    }
  });

  es.onerror = () => {
    updateConnectionStatus('error');
    // 5秒後に再接続を試みる
    setTimeout(() => {
      if (firebaseUrl) subscribeRealtime();
    }, 5000);
  };
}

// ============================================================
// 接続ステータス表示
// ============================================================

function updateConnectionStatus(status) {
  const labels = {
    connecting: '⏳ 接続中',
    connected:  '🟢 リアルタイム同期中',
    error:      '🔴 接続エラー',
  };
  DOM.connStatus.className = `conn-status conn-status--${status}`;
  DOM.connStatus.textContent = labels[status] ?? '';
}

// ============================================================
// セットアップ画面
// ============================================================

function showSetup() {
  const saved = getSavedUrl();
  if (saved) DOM.setupUrl.value = saved;
  DOM.setupOverlay.hidden = false;
  DOM.setupUrl.focus();
}

function hideSetup() {
  DOM.setupOverlay.hidden = true;
  DOM.setupTestResult.textContent = '';
  DOM.setupTestResult.className = 'setup-result';
}

function setSetupResult(msg, type) {
  DOM.setupTestResult.textContent = msg;
  DOM.setupTestResult.className = `setup-result setup-result--${type}`;
}

async function handleTestConnection() {
  const url = normalizeUrl(DOM.setupUrl.value);
  if (!url) { setSetupResult('URLを入力してください', 'error'); return; }

  DOM.setupTest.disabled = true;
  DOM.setupTest.textContent = 'テスト中…';
  setSetupResult('', '');

  try {
    await fbTest(url);
    setSetupResult('✅ 接続成功！「保存して接続」を押してください', 'success');
  } catch {
    setSetupResult('❌ 接続失敗。URLと権限設定を確認してください', 'error');
  } finally {
    DOM.setupTest.disabled = false;
    DOM.setupTest.textContent = '接続テスト';
  }
}

async function handleSaveConfig() {
  const url = normalizeUrl(DOM.setupUrl.value);
  if (!url) { setSetupResult('URLを入力してください', 'error'); return; }

  DOM.setupSave.disabled = true;
  DOM.setupSave.textContent = '接続中…';
  setSetupResult('', '');

  try {
    await fbTest(url);
    saveUrl(url);
    firebaseUrl = url;
    hideSetup();
    subscribeRealtime();
    showToast('🔥 Firebase に接続しました。全利用者で同期中！', 'success');
  } catch {
    setSetupResult('❌ 接続できません。URLと Realtime Database の設定を確認してください', 'error');
  } finally {
    DOM.setupSave.disabled = false;
    DOM.setupSave.textContent = '保存して接続';
  }
}

// ============================================================
// 初期化
// ============================================================

function init() {
  // 開始時刻の選択肢を生成
  START_TIMES.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    DOM.startSelect.appendChild(opt);
  });

  DOM.dateInput.value = todayStr();
  DOM.dateInput.min   = todayStr();

  // イベントリスナー
  DOM.form.addEventListener('submit', handleSubmit);
  DOM.durationBtns.forEach((btn) => {
    btn.addEventListener('click', () => handleDurationSelect(Number(btn.dataset.minutes)));
  });
  DOM.startSelect.addEventListener('change', updateTimePreview);
  DOM.searchInput.addEventListener('input', renderList);
  DOM.modalCancel.addEventListener('click', closeModal);
  DOM.modalConfirm.addEventListener('click', handleDeleteConfirm);
  DOM.modalOverlay.addEventListener('click', (e) => {
    if (e.target === DOM.modalOverlay) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!DOM.modalOverlay.hidden) closeModal();
      else if (!DOM.setupOverlay.hidden && firebaseUrl) hideSetup();
    }
  });

  // セットアップボタン
  DOM.setupTest.addEventListener('click', handleTestConnection);
  DOM.setupSave.addEventListener('click', handleSaveConfig);
  DOM.setupChangeBtn.addEventListener('click', showSetup);

  // 保存済みの Firebase URL があれば即接続
  const saved = getSavedUrl();
  if (saved) {
    firebaseUrl = saved;
    hideSetup();
    subscribeRealtime();
  } else {
    showSetup();
  }

  renderList();
  updateTotalCount();
}

// ============================================================
// 利用時間の選択
// ============================================================

function handleDurationSelect(minutes) {
  selectedDuration = minutes;
  DOM.durationBtns.forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.minutes) === minutes);
  });
  clearError(DOM.durationError);
  updateTimePreview();
}

// ============================================================
// 時間プレビュー更新
// ============================================================

function updateTimePreview() {
  const startTime = DOM.startSelect.value;
  if (startTime && selectedDuration) {
    const endTime = calcEndTime(startTime, selectedDuration);
    DOM.previewTime.textContent = `${startTime} ～ ${endTime}`;
    DOM.timePreview.classList.add('has-time');
  } else {
    DOM.previewTime.textContent = '──:── ～ ──:──';
    DOM.timePreview.classList.remove('has-time');
  }
}

// ============================================================
// バリデーション
// ============================================================

function showError(el, msg) {
  el.textContent = `⚠ ${msg}`;
  el.classList.add('visible');
}

function clearError(el) {
  el.textContent = '';
  el.classList.remove('visible');
}

function clearAllErrors() {
  [DOM.nameError, DOM.dateError, DOM.startError, DOM.durationError].forEach(clearError);
  [DOM.nameInput, DOM.dateInput, DOM.startSelect].forEach((el) => el.classList.remove('error'));
}

function validate() {
  clearAllErrors();
  let valid = true;
  const name      = DOM.nameInput.value.trim();
  const date      = DOM.dateInput.value;
  const startTime = DOM.startSelect.value;

  if (!name)      { showError(DOM.nameError, '教室名を入力してください'); DOM.nameInput.classList.add('error'); valid = false; }
  if (!date)      { showError(DOM.dateError, '予約日を選択してください'); DOM.dateInput.classList.add('error'); valid = false; }
  if (!startTime) { showError(DOM.startError, '開始時刻を選択してください'); DOM.startSelect.classList.add('error'); valid = false; }
  if (!selectedDuration) { showError(DOM.durationError, '利用時間を選択してください'); valid = false; }

  // 重複チェック：同じ教室名 × 同じ日付は不可
  if (valid) {
    const dup = bookings.find((b) => b.name === name && b.date === date);
    if (dup) {
      showError(DOM.nameError, `「${name}」は ${formatDateJP(date)} に既に予約が入っています`);
      DOM.nameInput.classList.add('error');
      valid = false;
    }
  }

  return valid;
}

// ============================================================
// フォーム送信（予約追加）
// ============================================================

async function handleSubmit(e) {
  e.preventDefault();
  if (!validate()) return;

  if (!firebaseUrl) {
    showToast('❌ Firebase 未接続です。⚙ 設定を確認してください', 'error');
    showSetup();
    return;
  }

  DOM.submitBtn.disabled = true;

  const name          = DOM.nameInput.value.trim();
  const date          = DOM.dateInput.value;
  const startTime     = DOM.startSelect.value;
  const endTime       = calcEndTime(startTime, selectedDuration);
  const durationLabel = DURATION_OPTIONS.find((o) => o.minutes === selectedDuration)?.label ?? '';

  const newBooking = {
    id: generateId(),
    name,
    date,
    startTime,
    endTime,
    durationMinutes: selectedDuration,
    durationLabel,
    createdAt: new Date().toISOString(),
  };

  try {
    await fbAdd(newBooking);
    // SSE が自動的に全クライアントを更新するため、ここでは renderList 不要
    resetForm();
    showToast(`✅ 「${name}」の予約を追加しました`, 'success');
    animateSubmitBtn();
  } catch (err) {
    console.error(err);
    showToast('❌ 予約の追加に失敗しました。接続を確認してください', 'error');
  } finally {
    DOM.submitBtn.disabled = false;
  }
}

function resetForm() {
  DOM.nameInput.value = '';
  DOM.dateInput.value = todayStr();
  DOM.startSelect.value = '';
  selectedDuration = null;
  DOM.durationBtns.forEach((btn) => btn.classList.remove('active'));
  DOM.previewTime.textContent = '──:── ～ ──:──';
  DOM.timePreview.classList.remove('has-time');
  clearAllErrors();
}

function animateSubmitBtn() {
  const ripple = DOM.submitBtn.querySelector('.btn-ripple');
  ripple.classList.remove('animate');
  void ripple.offsetWidth; // reflow
  ripple.classList.add('animate');
}

// ============================================================
// 予約一覧レンダリング
// ============================================================

function renderList() {
  const query = DOM.searchInput.value.trim().toLowerCase();

  const filtered = bookings
    .filter((b) => b.name.toLowerCase().includes(query))
    .sort((a, b) => {
      const dc = a.date.localeCompare(b.date);
      return dc !== 0 ? dc : a.startTime.localeCompare(b.startTime);
    });

  DOM.emptyState.style.display = filtered.length === 0 ? 'flex' : 'none';

  // 既存アイテムをすべて削除して再描画
  DOM.bookingList.querySelectorAll('.booking-item').forEach((el) => el.remove());

  filtered.forEach((booking, i) => {
    DOM.bookingList.appendChild(createBookingItem(booking, i));
  });
}

function createBookingItem(booking, index) {
  const item = document.createElement('div');
  item.className = 'booking-item';
  item.setAttribute('role', 'listitem');
  item.dataset.id  = booking.id;
  item.dataset.key = booking._key ?? '';
  item.style.animationDelay = `${index * 40}ms`;

  item.innerHTML = `
    <div class="booking-icon">🏫</div>
    <div class="booking-info">
      <div class="booking-name">${escapeHtml(booking.name)}</div>
      <div class="booking-meta">
        <span class="booking-date">📅 ${formatDateJP(booking.date)}</span>
        <span class="booking-time">${booking.startTime} ～ ${booking.endTime}</span>
        <span class="booking-duration-tag">⏱ ${booking.durationLabel}</span>
      </div>
    </div>
    <button
      class="delete-btn"
      aria-label="${escapeHtml(booking.name)}の予約を削除"
      data-id="${booking.id}"
      title="削除"
    >🗑</button>
  `;

  item.querySelector('.delete-btn').addEventListener('click', () => openModal(booking));
  return item;
}

// ============================================================
// 件数更新
// ============================================================

function updateTotalCount() {
  DOM.totalCount.textContent = bookings.length;
}

// ============================================================
// 削除モーダル
// ============================================================

function openModal(booking) {
  pendingDeleteId = booking.id;
  DOM.modalDesc.innerHTML = `
    <strong>${escapeHtml(booking.name)}</strong> の予約<br>
    ${formatDateJP(booking.date)}<br>
    ${booking.startTime} ～ ${booking.endTime}（${booking.durationLabel}）<br><br>
    この操作は元に戻せません。
  `;
  DOM.modalOverlay.hidden = false;
  DOM.modalConfirm.focus();
}

function closeModal() {
  DOM.modalOverlay.hidden = true;
  pendingDeleteId = null;
}

async function handleDeleteConfirm() {
  if (!pendingDeleteId) return;

  // ✅ バグ修正：closeModal() を呼ぶ前にIDをローカル変数に退避する
  //    closeModal() は pendingDeleteId を null にするため、
  //    コールバック内で参照すると null になってしまう問題を防ぐ。
  const idToDelete = pendingDeleteId;
  const bookingToDelete = bookings.find((b) => b.id === idToDelete);

  closeModal(); // pendingDeleteId = null になるが idToDelete は保持される

  if (!bookingToDelete || !bookingToDelete._key) {
    showToast('❌ 削除対象が見つかりません', 'error');
    return;
  }

  // ① 対象要素にCSSトランジション（removing クラス）を適用して視覚的に消す
  const itemEl = DOM.bookingList.querySelector(`[data-id="${idToDelete}"]`);
  if (itemEl) {
    itemEl.classList.add('removing');
    // トランジション完了（250ms）を待ってから DOM から削除する
    await new Promise((resolve) => setTimeout(resolve, 280));
    itemEl.remove(); // アニメーション後に DOM から完全に除去
  }

  // ② ローカルの bookings 配列からも除去して即時反映
  bookings = bookings.filter((b) => b.id !== idToDelete);
  updateTotalCount();
  // emptyState の表示更新
  const visibleItems = DOM.bookingList.querySelectorAll('.booking-item');
  DOM.emptyState.style.display = visibleItems.length === 0 ? 'flex' : 'none';

  // ③ Firebase に削除を送信（SSE で他の全利用者にも自動通知される）
  try {
    await fbDelete(bookingToDelete._key);
    showToast(`🗑 「${bookingToDelete.name}」の予約を削除しました`, 'warning');
  } catch (err) {
    console.error(err);
    showToast('❌ 削除に失敗しました。接続を確認してください', 'error');
    // 失敗時は SSE が再同期するまで待つ（次回 put イベントで復元される）
  }
}

// ============================================================
// トースト通知
// ============================================================

function showToast(message, type = 'success', duration = 3500) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  DOM.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('hiding');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, duration);
}

// ============================================================
// アプリ起動
// ============================================================

document.addEventListener('DOMContentLoaded', init);
