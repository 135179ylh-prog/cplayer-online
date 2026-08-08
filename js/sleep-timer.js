// Sleep timer, extracted from js/app.js.
// The three timer bindings and the storage key are module-private: nothing
// outside the timer block referenced them. getSleepTimerRemainingMs comes from
// core-utils, and the player pieces it needs are injected.
import { getSleepTimerRemainingMs } from './core-utils.js';

// Set once during startup, before the timer UI is wired.
let deps = {};
export function configureSleepTimer(next) {
    deps = next;
}

let sleepTimerEndAt = 0;
let sleepTimerTimeout = null;
let sleepTimerInterval = null;
const SLEEP_TIMER_KEY = 'cp_sleep_timer_end_at';

function formatSleepTimerRemaining(remainingMs) {
    const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
    if (totalMinutes < 60) return totalMinutes + ' 分钟';
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes ? hours + ' 小时 ' + minutes + ' 分钟' : hours + ' 小时';
}

function updateSleepTimerUI() {
    const status = document.getElementById('sleepTimerStatus');
    const select = document.getElementById('sleepTimerSelect');
    const button = document.getElementById('sleepTimerBtn');
    const remaining = getSleepTimerRemainingMs(sleepTimerEndAt);
    if (status) status.textContent = remaining ? '剩余 ' + formatSleepTimerRemaining(remaining) : '未设置';
    if (button) button.textContent = remaining ? '取消' : '设置';
    if (!remaining && select) select.value = '0';
}

function clearSleepTimer(options) {
    options = options || {};
    if (sleepTimerTimeout) clearTimeout(sleepTimerTimeout);
    if (sleepTimerInterval) clearInterval(sleepTimerInterval);
    sleepTimerTimeout = null;
    sleepTimerInterval = null;
    sleepTimerEndAt = 0;
    deps.removeLocalStorage(SLEEP_TIMER_KEY);
    updateSleepTimerUI();
    if (options.notify && typeof deps.showToast === 'function') deps.showToast('睡眠定时已取消');
}

function handleSleepTimerExpired() {
    try { deps.audio.pause(); } catch (error) {}
    deps.savePlaybackSession('sleep_timer', true);
    clearSleepTimer();
    if (typeof deps.showToast === 'function') deps.showToast('睡眠定时到点，已暂停播放');
}

function scheduleSleepTimer() {
    if (sleepTimerTimeout) clearTimeout(sleepTimerTimeout);
    if (sleepTimerInterval) clearInterval(sleepTimerInterval);
    const remaining = getSleepTimerRemainingMs(sleepTimerEndAt);
    if (!remaining) {
        clearSleepTimer();
        return false;
    }
    sleepTimerTimeout = setTimeout(handleSleepTimerExpired, remaining);
    sleepTimerInterval = setInterval(updateSleepTimerUI, 1000);
    updateSleepTimerUI();
    return true;
}

function setSleepTimer(minutes) {
    const value = Number(minutes);
    if (!Number.isFinite(value) || value <= 0) {
        clearSleepTimer({ notify: true });
        return;
    }
    sleepTimerEndAt = Date.now() + value * 60000;
    deps.writeLocalStorage(SLEEP_TIMER_KEY, String(sleepTimerEndAt));
    scheduleSleepTimer();
    if (typeof deps.showToast === 'function') deps.showToast('睡眠定时已设置：' + value + ' 分钟');
}

export function setupSleepTimerUI() {
    const select = document.getElementById('sleepTimerSelect');
    const button = document.getElementById('sleepTimerBtn');
    if (!select || !button || button.dataset.bound === '1') return;
    button.dataset.bound = '1';
    button.addEventListener('click', function () {
        if (getSleepTimerRemainingMs(sleepTimerEndAt)) {
            clearSleepTimer({ notify: true });
            return;
        }
        if (Number(select.value) <= 0) {
            if (typeof deps.showToast === 'function') deps.showToast('请先选择定时时长', true);
            return;
        }
        setSleepTimer(select.value);
    });
    sleepTimerEndAt = Number(deps.readLocalStorage(SLEEP_TIMER_KEY, '0')) || 0;
    if (getSleepTimerRemainingMs(sleepTimerEndAt)) scheduleSleepTimer();
    else clearSleepTimer();
}

// API 密钥/地址设置：只绑定按钮到 saveApiSettings/resetApiSettings。
// 实际读写逻辑集中在那两个函数里（含地址校验与本地存储）。
