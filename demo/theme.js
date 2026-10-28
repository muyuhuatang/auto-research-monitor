// Colour theme: light (default) or dark.
//
// Loaded synchronously in <head> on both pages, before anything paints, so the page
// never flashes the wrong theme. The choice is a per-browser convenience kept in
// localStorage; storage can be unavailable (private window, blocked site data), and
// then the page simply starts light every time.
//
// Controls opt in by markup, so neither page needs its own wiring:
//   <input type="radio" name="theme" value="light|dark">  — the viewer's settings menu
//   <button data-theme-toggle>                            — the dashboard's toggle
// Anything that draws its own colours (the graph canvas) listens for the
// `aivis-theme-change` event on window.
(function () {
    'use strict';
    var KEY = 'aivis-theme';
    var THEMES = ['light', 'dark'];
    var DEFAULT = 'light';

    function stored() {
        try {
            var t = window.localStorage.getItem(KEY);
            return THEMES.indexOf(t) >= 0 ? t : null;
        } catch (e) {
            return null;
        }
    }

    function get() {
        var t = document.documentElement.getAttribute('data-theme');
        return THEMES.indexOf(t) >= 0 ? t : DEFAULT;
    }

    function sync() {
        var t = get();
        var radios = document.querySelectorAll('input[name="theme"]');
        for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === t;
        var toggles = document.querySelectorAll('[data-theme-toggle]');
        for (var j = 0; j < toggles.length; j++) {
            toggles[j].setAttribute('aria-pressed', t === 'dark' ? 'true' : 'false');
            toggles[j].title = t === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme';
        }
    }

    function set(t) {
        if (THEMES.indexOf(t) < 0 || t === get()) return;
        document.documentElement.setAttribute('data-theme', t);
        try { window.localStorage.setItem(KEY, t); } catch (e) { /* not remembered */ }
        sync();
        window.dispatchEvent(new CustomEvent('aivis-theme-change', { detail: { theme: t } }));
    }

    document.documentElement.setAttribute('data-theme', stored() || DEFAULT);

    document.addEventListener('DOMContentLoaded', function () {
        sync();
        document.addEventListener('change', function (e) {
            var el = e.target;
            if (el && el.name === 'theme' && el.checked) set(el.value);
        });
        document.addEventListener('click', function (e) {
            var btn = e.target && e.target.closest ? e.target.closest('[data-theme-toggle]') : null;
            if (btn) set(get() === 'dark' ? 'light' : 'dark');
        });
    });

    window.AivisTheme = { get: get, set: set };
})();
