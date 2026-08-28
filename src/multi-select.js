/**
 * Multi-select dropdown — a shared filter control (sections, rounds, …).
 *
 * The popover is persistent (mounted on the modal), while the trigger button
 * is rendered inline by the caller and re-rendered freely on every state
 * change — so the app's innerHTML re-render of the filter bar never disturbs
 * an open popover. The caller renders a `<button data-filter="…">` showing
 * `summaryText()`, and routes its click to `toggle(triggerEl)`.
 *
 * Selection is a Set of string values; empty is coerced to "all" (there is no
 * "show nothing" state). Clicking an option while everything is selected solos
 * that option — matching the section-filter behavior it replaces.
 *
 *   createMultiSelect({ getItems, getSelected, onChange, noun, allLabel })
 *     getItems()    -> [{ value, label }]
 *     getSelected() -> Set of selected values
 *     onChange(set) -> apply the new selection (caller persists + re-renders)
 *     noun          -> singular noun for the summary ("round", "section")
 *     allLabel      -> label for the "all" state/row (default "All <noun>s")
 */

import { escapeHtml } from './utils.js';

export function createMultiSelect({ getItems, getSelected, onChange, noun = 'item', allLabel }) {
    const ALL = allLabel || `All ${noun}s`;
    let container = document.body;
    const popover = document.createElement('div');
    popover.className = 'ms-popover hidden';
    document.body.appendChild(popover);

    let isOpen = false;
    let anchor = null;

    const items = () => getItems() || [];
    const selected = () => new Set([...(getSelected() || [])].map(String));
    const allValues = () => items().map((it) => String(it.value));
    const isAllOn = () => {
        const sel = selected();
        const all = allValues();
        return all.length > 0 && all.every((v) => sel.has(v));
    };

    function summaryText() {
        const all = items();
        if (all.length === 0) return ALL;
        if (isAllOn()) return ALL;
        const sel = selected();
        const on = all.filter((it) => sel.has(String(it.value)));
        if (on.length === 0) return ALL; // empty coerces to all
        if (on.length <= 2) return on.map((it) => it.label).join(', ');
        return `${on.length} ${noun}s`;
    }

    function optionRow(cls, value, label, on) {
        const attr = value == null ? 'data-ms-all' : `data-ms-value="${escapeHtml(String(value))}"`;
        return (
            `<button type="button" class="ms-option ${cls}${on ? ' ms-on' : ''}" role="option" aria-selected="${on}" ${attr}>` +
            `<span class="ms-check">${on ? '✓' : ''}</span>` +
            `<span class="ms-option-label">${escapeHtml(label)}</span>` +
            `</button>`
        );
    }

    function renderPopover() {
        const sel = selected();
        const rows = items()
            .map((it) => optionRow('', it.value, it.label, sel.has(String(it.value))))
            .join('');
        popover.innerHTML = optionRow('ms-all', null, ALL, isAllOn()) + `<div class="ms-divider"></div>` + rows;
    }

    function position() {
        if (!anchor) return;
        const r = anchor.getBoundingClientRect();
        popover.style.top = `${r.bottom + 4}px`;
        const left = Math.max(8, Math.min(r.left, window.innerWidth - popover.offsetWidth - 8));
        popover.style.left = `${left}px`;
        popover.style.minWidth = `${r.width}px`;
    }

    function open(triggerEl) {
        anchor = triggerEl;
        container = triggerEl.closest('.modal') || document.body;
        if (popover.parentElement !== container) container.appendChild(popover);
        renderPopover();
        popover.classList.remove('hidden');
        isOpen = true;
        position();
        document.addEventListener('click', onOutside, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', position);
        window.addEventListener('scroll', position, true);
    }

    function close() {
        if (!isOpen) return;
        popover.classList.add('hidden');
        isOpen = false;
        anchor = null;
        document.removeEventListener('click', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', position);
        window.removeEventListener('scroll', position, true);
    }

    function onOutside(e) {
        if (popover.contains(e.target) || (anchor && anchor.contains(e.target))) return;
        close();
    }
    function onKey(e) {
        if (e.key === 'Escape') close();
    }

    function toggle(triggerEl) {
        if (isOpen) close();
        else open(triggerEl);
    }

    function applyToggle(value) {
        const all = allValues();
        let next;
        if (isAllOn()) {
            next = new Set([value]); // solo when everything is on
        } else {
            next = selected();
            if (next.has(value)) next.delete(value);
            else next.add(value);
            if (next.size === 0) next = new Set(all); // never empty — empty means all
        }
        onChange(next);
        renderPopover();
    }

    function applyAll() {
        onChange(new Set(allValues()));
        renderPopover();
    }

    popover.addEventListener('click', (e) => {
        if (e.target.closest('[data-ms-all]')) {
            applyAll();
            return;
        }
        const opt = e.target.closest('[data-ms-value]');
        if (opt) applyToggle(opt.dataset.msValue);
    });

    return {
        summaryText,
        toggle,
        close,
        isOpen: () => isOpen,
        refresh: () => {
            if (isOpen) renderPopover();
        },
        destroy: () => {
            close();
            popover.remove();
        },
    };
}
