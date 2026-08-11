import { CONFIG } from './config.js';
import { showToast } from './toast.js';
import { openModal, closeModal } from './modal.js';
import { checkPushStatus, syncPushSubscription, updatePushPrefs } from './push.js';
import { searchPlayers } from './games.js';
import { syncStylePane } from './style.js';

const TABS = ['you', 'style', 'about'];

export function initSettings(mount) {
    mount.innerHTML = `
        <div id="settings-modal" class="modal hidden" role="dialog" aria-labelledby="settings-modal-title" aria-modal="true">
            <div class="modal-backdrop"></div>
            <div class="modal-content settings-modal-content">
                <button data-close-modal class="style-close-btn" aria-label="Close">&times;</button>
                <h2 id="settings-modal-title" class="visually-hidden">Settings</h2>
                <div class="settings-tabs" role="tablist" aria-label="Settings sections">
                    <button type="button" class="settings-tab" data-settings-tab="you" role="tab">You</button>
                    <button type="button" class="settings-tab" data-settings-tab="style" role="tab">Style</button>
                    <button type="button" class="settings-tab" data-settings-tab="about" role="tab">About</button>
                </div>
                <div class="settings-pane" data-pane="you" role="tabpanel">
                    <div class="setting-group">
                        <label for="player-name-input">Your Name</label>
                        <div class="setting-name-wrap">
                            <input type="text" id="player-name-input" placeholder="Search for your name..." autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="settings-autocomplete">
                            <div id="settings-autocomplete" class="browser-autocomplete hidden" role="listbox"></div>
                        </div>
                        <p class="setting-hint">Start typing to find your name, or enter it manually.</p>
                    </div>
                    <div id="push-section" class="setting-group" data-push="unknown">
                        <label>Notifications</label>
                        <p class="push-when-unsupported setting-hint">Push notifications are not supported in this browser.</p>
                        <button class="push-when-unsubscribed modal-btn modal-btn-primary" data-action="enable-push">Enable Push Notifications</button>
                        <p class="push-when-unsubscribed setting-hint">Get browser notifications when pairings or results are posted.</p>
                        <div class="push-when-subscribed notification-status-row">
                            <span class="notification-status-badge">Push Active</span>
                            <button data-action="disable-push" class="modal-btn modal-btn-secondary modal-btn-small">Disable</button>
                        </div>
                        <div class="push-when-subscribed notify-prefs">
                            <label class="notify-pref-label">
                                <input type="checkbox" id="push-pref-pairings" checked>
                                Pairings posted
                            </label>
                            <label class="notify-pref-label">
                                <input type="checkbox" id="push-pref-results" checked>
                                Results posted
                            </label>
                        </div>
                        <p id="push-status" class="notification-status hidden" role="alert" aria-live="assertive"></p>
                    </div>
                    <p class="setting-hint setting-feedback">Suggestions, bugs, or feedback? Email <a href="mailto:info@tnmpairings.com">info@tnmpairings.com</a></p>
                    <div class="modal-buttons">
                        <button data-close-modal class="modal-btn modal-btn-secondary">Cancel</button>
                        <button data-action="save-settings" class="modal-btn modal-btn-primary">Save</button>
                    </div>
                </div>
                <div class="settings-pane hidden" data-pane="style" id="settings-style-pane" role="tabpanel"></div>
                <div class="settings-pane hidden" data-pane="about" role="tabpanel"></div>
            </div>
        </div>`;
    document.getElementById('push-pref-pairings').addEventListener('change', updatePushPrefs);
    document.getElementById('push-pref-results').addEventListener('change', updatePushPrefs);

    // About pane content lives in index.html as a template — adopt it.
    const aboutTpl = document.getElementById('settings-about-template');
    const aboutPane = mount.querySelector('[data-pane="about"]');
    if (aboutTpl) aboutPane.append(aboutTpl.content);

    // Tab switching (also handles the About pane's "Set up your name →")
    mount.querySelector('#settings-modal').addEventListener('click', (e) => {
        // Outside-click saves rather than discards — a typed name should
        // survive a stray backdrop click. Cancel remains the discard path.
        if (e.target.classList.contains('modal-backdrop')) {
            e.stopPropagation();
            mount.querySelector('[data-action="save-settings"]').click();
            return;
        }
        const tabBtn = e.target.closest('[data-settings-tab]');
        if (tabBtn) switchTab(tabBtn.dataset.settingsTab);
    });
}

// --- Settings modal ---

let _autocompleteReady = false;

function switchTab(tab) {
    if (!TABS.includes(tab)) tab = 'you';
    const modal = document.getElementById('settings-modal');
    for (const btn of modal.querySelectorAll('.settings-tab')) {
        const on = btn.dataset.settingsTab === tab;
        btn.classList.toggle('settings-tab-active', on);
        btn.setAttribute('aria-selected', on);
    }
    for (const pane of modal.querySelectorAll('.settings-pane')) {
        pane.classList.toggle('hidden', pane.dataset.pane !== tab);
    }
    if (tab === 'style') syncStylePane();
    if (tab === 'you') {
        const input = document.getElementById('player-name-input');
        input.value = CONFIG.playerName;
        checkPushStatus();
    }
}

/**
 * Open the settings panel on a tab: 'you' (default), 'style', or 'about'.
 * opts.privacy expands the privacy policy within the About tab.
 */
export function openSettings(tab = 'you', { privacy = false } = {}) {
    switchTab(tab);
    const details = document.getElementById('privacy-details');
    if (details) details.open = privacy;
    const focusTarget = tab === 'you' ? document.getElementById('player-name-input') : undefined;
    openModal('settings-modal', focusTarget);
    document.getElementById('settings-autocomplete').classList.add('hidden');
    if (!_autocompleteReady) {
        initNameAutocomplete(document.getElementById('player-name-input'));
        _autocompleteReady = true;
    }
}

export function saveSettings(checkPairings) {
    const input = document.getElementById('player-name-input');
    const newName = input.value.trim();
    const oldName = CONFIG.playerName;

    CONFIG.playerName = newName;
    CONFIG.playerNorm = input.dataset.norm || '';

    closeModal('settings-modal');

    if (newName !== oldName) {
        // Sync push subscription with new name
        syncPushSubscription();
        // Always re-check to rebuild pairing info and history for the new name
        checkPairings();
    }

    if (newName) {
        showToast(`Saved! Looking for "${newName}" in pairings.`, 'success');
    } else {
        showToast('Name cleared. Pairing info disabled.', 'success');
    }
}

// --- Player name autocomplete ---

function initNameAutocomplete(input) {
    const dropdown = document.getElementById('settings-autocomplete');

    input.addEventListener('input', () => {
        const query = input.value.trim();
        if (query.length === 0) {
            dropdown.classList.add('hidden');
            input.setAttribute('aria-expanded', 'false');
            return;
        }

        const matches = searchPlayers(query);

        if (matches.length === 0) {
            dropdown.innerHTML = '<div class="browser-ac-empty">No players found</div>';
        } else {
            dropdown.innerHTML = matches
                .map((p) => {
                    const idx = p.name.toLowerCase().indexOf(query.toLowerCase());
                    const before = p.name.slice(0, idx);
                    const match = p.name.slice(idx, idx + query.length);
                    const after = p.name.slice(idx + query.length);
                    return `<button type="button" class="browser-ac-item" role="option" data-player="${p.name}" data-norm="${p.norm}">${before}<strong>${match}</strong>${after}</button>`;
                })
                .join('');
        }
        dropdown.classList.remove('hidden');
        input.setAttribute('aria-expanded', 'true');
    });

    dropdown.addEventListener('click', (e) => {
        const item = e.target.closest('[data-player]');
        if (!item) return;
        input.value = item.dataset.player;
        input.dataset.norm = item.dataset.norm || '';
        dropdown.classList.add('hidden');
        input.setAttribute('aria-expanded', 'false');
    });

    input.addEventListener('keydown', (e) => {
        if (dropdown.classList.contains('hidden')) return;
        const items = dropdown.querySelectorAll('.browser-ac-item');
        if (items.length === 0) return;
        const focused = dropdown.querySelector('.browser-ac-focused');
        let idx = [...items].indexOf(focused);

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (focused) focused.classList.remove('browser-ac-focused');
            idx = idx < items.length - 1 ? idx + 1 : 0;
            items[idx].classList.add('browser-ac-focused');
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (focused) focused.classList.remove('browser-ac-focused');
            idx = idx > 0 ? idx - 1 : items.length - 1;
            items[idx].classList.add('browser-ac-focused');
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const name = focused?.dataset.player || input.value.trim();
            if (focused) input.value = name;
            dropdown.classList.add('hidden');
            input.setAttribute('aria-expanded', 'false');
        } else if (e.key === 'Escape') {
            dropdown.classList.add('hidden');
            input.setAttribute('aria-expanded', 'false');
        }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.setting-name-wrap')) {
            dropdown.classList.add('hidden');
            input.setAttribute('aria-expanded', 'false');
        }
    });
}
