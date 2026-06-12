/* ============================================================
   教室予約管理システム - アプリケーションロジック
   ============================================================ */

'use strict';

// ============================================================
// 定数・設定
// ============================================================
const STORAGE_KEY = 'classroom_bookings_v1';
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
let bookings = [];          // { id, name, date, startTime, endTime, durationMinutes }
let selectedDuration = null; // 選択中の利用時間（分）
let pendingDeleteId = null;  // 削除確認待ちの予約ID

// ============================================================
// DOM 要素の参照
// ============================================================
const $ = (id) => document.getElementById(id);

const DOM = {
  form:           $('booking-form'),
  nameInput:      $('classroom-name'),
  dateInput:      $('booking-date'),
  startSelect:    $('start-time'),
  durationBtns:   document.querySelectorAll('.duration-btn'),
  submitBtn:      $('submit-btn'),
  timePreview:    $('time-preview'),
  previewTime:    $('preview-time'),
  bookingList:    $('booking-list'),
  emptyState:     $('empty-state'),
  searchInput:    $('search-input'),
  totalCount:     $('total-count'),
  toastContainer: $('toast-container'),
  modalOverlay:   $('modal-overlay'),
  modalDesc:      $('modal-desc'),
  modalCancel:    $('modal-cancel'),
  modalConfirm:   $('modal-confirm'),
  // エラーメッセージ
  nameError:      $('name-error'),
  dateError:      $('date-error'),
  startError:     $('start-error'),
  durationError:  $('duration-error'),
};

// ============================================================
// ユーティリティ関数
// ============================================================

/**
 * 分を HH:MM 形式に変換
 */
function minutesToHHMM(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * 開始時刻 + 利用時間(分) から終了時刻を計算
 */
function calcEndTime(startTime, durationMinutes) {
  const [h, m] = startTime.split(':').map(Number);
  const totalMinutes = h * 60 + m + durationMinutes;
  return minutesToHHMM(totalMinutes);
}

/**
 * 一意な ID を生成
 */
function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * 日付を日本語フォーマットに変換（例: 2026年6月12日(金)）
 */
function formatDateJP(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${days[d.getDay()]})`;
}

/**
 * 今日の日付を YYYY-MM-DD 形式で返す
 */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ============================================================
// ローカルストレージ
// ============================================================

function loadBookings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveBookings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(bookings));
}

// ============================================================
// 初期化
// ============================================================

function init() {
  // データ読み込み
  bookings = loadBookings();

  // 開始時刻の選択肢を生成
  START_TIMES.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    DOM.startSelect.appendChild(opt);
  });

  // 今日の日付をデフォルト設定
  DOM.dateInput.value = todayStr();
  DOM.dateInput.min = todayStr();

  // イベントリスナー登録
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

  // キーボードでモーダルを閉じる
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !DOM.modalOverlay.hidden) closeModal();
  });

  // 初期レンダリング
  renderList();
  updateTotalCount();
}

// ============================================================
// 利用時間の選択
// ============================================================

function handleDurationSelect(minutes) {
  selectedDuration = minutes;

  // ボタンのアクティブ状態を更新
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

  // 対応する input に error クラスを付与
  const groupEl = el.previousElementSibling || el.parentElement.querySelector('.form-input, .form-select');
  if (groupEl) groupEl.classList.add('error');
}

function clearError(el) {
  el.textContent = '';
  el.classList.remove('visible');

  const groupEl = el.previousElementSibling || el.parentElement.querySelector('.form-input, .form-select');
  if (groupEl) groupEl.classList.remove('error');
}

function clearAllErrors() {
  [DOM.nameError, DOM.dateError, DOM.startError, DOM.durationError].forEach(clearError);
}

function validate() {
  clearAllErrors();
  let valid = true;
  const name = DOM.nameInput.value.trim();
  const date = DOM.dateInput.value;
  const startTime = DOM.startSelect.value;

  if (!name) {
    showError(DOM.nameError, '教室名を入力してください');
    DOM.nameInput.classList.add('error');
    valid = false;
  }

  if (!date) {
    showError(DOM.dateError, '予約日を選択してください');
    DOM.dateInput.classList.add('error');
    valid = false;
  }

  if (!startTime) {
    showError(DOM.startError, '開始時刻を選択してください');
    DOM.startSelect.classList.add('error');
    valid = false;
  }

  if (!selectedDuration) {
    showError(DOM.durationError, '利用時間を選択してください');
    valid = false;
  }

  // 重複チェック：同じ教室名 & 同じ日付の予約が既に存在する場合はNG
  if (valid) {
    const duplicate = bookings.find(
      (b) => b.name === name && b.date === date
    );
    if (duplicate) {
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

function handleSubmit(e) {
  e.preventDefault();

  if (!validate()) return;

  const name = DOM.nameInput.value.trim();
  const date = DOM.dateInput.value;
  const startTime = DOM.startSelect.value;
  const endTime = calcEndTime(startTime, selectedDuration);
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

  bookings.push(newBooking);
  saveBookings();

  // フォームリセット
  resetForm();

  // UI更新
  renderList();
  updateTotalCount();

  // 成功トースト
  showToast(`✅ 「${name}」の予約を追加しました`, 'success');

  // ボタンアニメーション
  animateSubmitBtn();
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

  // フィルタリング＆日付・時刻順でソート
  const filtered = bookings
    .filter((b) => b.name.toLowerCase().includes(query))
    .sort((a, b) => {
      const dateCompare = a.date.localeCompare(b.date);
      if (dateCompare !== 0) return dateCompare;
      return a.startTime.localeCompare(b.startTime);
    });

  // 空の状態
  DOM.emptyState.style.display = filtered.length === 0 ? 'flex' : 'none';

  // 既存アイテムを削除（空の状態以外）
  const existing = DOM.bookingList.querySelectorAll('.booking-item');
  existing.forEach((el) => el.remove());

  // アイテムを追加
  filtered.forEach((booking, i) => {
    const item = createBookingItem(booking, i);
    DOM.bookingList.appendChild(item);
  });
}

function createBookingItem(booking, index) {
  const item = document.createElement('div');
  item.className = 'booking-item';
  item.setAttribute('role', 'listitem');
  item.dataset.id = booking.id;
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

  item.querySelector('.delete-btn').addEventListener('click', () => {
    openModal(booking);
  });

  return item;
}

/**
 * XSS 防止のため HTML をエスケープ
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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

function handleDeleteConfirm() {
  if (!pendingDeleteId) return;

  const booking = bookings.find((b) => b.id === pendingDeleteId);
  if (!booking) { closeModal(); return; }

  // アニメーションで削除
  const itemEl = DOM.bookingList.querySelector(`[data-id="${pendingDeleteId}"]`);
  if (itemEl) {
    itemEl.classList.add('removing');
    itemEl.addEventListener('animationend', () => {
      bookings = bookings.filter((b) => b.id !== pendingDeleteId);
      saveBookings();
      renderList();
      updateTotalCount();
      showToast(`🗑 「${booking.name}」の予約を削除しました`, 'warning');
    }, { once: true });
  } else {
    bookings = bookings.filter((b) => b.id !== pendingDeleteId);
    saveBookings();
    renderList();
    updateTotalCount();
  }

  closeModal();
}

// ============================================================
// トースト通知
// ============================================================

function showToast(message, type = 'success', duration = 3000) {
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
