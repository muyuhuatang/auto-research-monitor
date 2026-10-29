/* Auto-Research Monitor - online demo loader.
 *
 * The static site (scripts/build_static.py) has no server behind it. This file loads
 * before every other script on its pages and stands in for one:
 *   - a read the demo exported is answered from data/ (see fileFor below),
 *   - search runs here, over the exported graph, the way the server's search does,
 *   - anything that writes is refused with a read-only message,
 *   - the live event stream never opens, because nothing will ever arrive.
 * The viewer and the dashboard themselves are the app's own files, unchanged except
 * that their asset links are relative.
 */
(function () {
    'use strict';

    const DATA = 'data/';
    // Where the banner sends people, and what it says. build_static.py points it at the
    // landing page's early-access section while the code repository is private.
    const MORE = ['../#quickstart', 'request early access to watch your own agent'];
    const READ_ONLY = 'The online demo is read-only. Install Auto-Research Monitor to run your own tasks.';
    const params = new URLSearchParams(location.search);
    const task = params.get('task');
    if (/view\.html$/.test(location.pathname) && !/^[a-f0-9]+$/.test(task || '')) {
        location.replace('index.html');        // the viewer needs a task; the list has them
        return;
    }
    window.AIVIS_STATIC = { task: task };
    document.documentElement.classList.add('static-demo');

    function json(body, status) {
        return new Response(JSON.stringify(body), {
            status: status || 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // The server's GET routes -> the files build_static.py wrote. null: not in the demo.
    function fileFor(path) {
        if (path === '/api/tasks' || path === '/api/tasks/all') return 'tasks.json';
        if (path === '/api/config') return 'config.json';
        if (path === '/api/usage') return 'usage.json';
        const m = path.match(/^\/api\/tasks\/([a-f0-9]+)\/(.+)$/);
        if (!m) return null;
        const id = m[1], rest = m[2];
        if (rest === 'report.md') return `${id}/report.md`;
        if (/^[a-z-]+(\/[a-z-]+)?$/.test(rest)) return `${id}/${rest}.json`;
        return null;
    }

    const realFetch = window.fetch.bind(window);
    const cache = new Map();
    function load(file) {
        if (!cache.has(file)) {
            cache.set(file, realFetch(DATA + file).then(r => {
                if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
                return r.json();
            }));
        }
        return cache.get(file);
    }

    // GraphQuery.search in server/graph/query.py: id, label, claim text, description,
    // or any metric value, case-insensitively.
    function search(id, q) {
        q = q.toLowerCase().trim();
        return load(`${id}/graph.json`).then(g => (g.elements || [])
            .filter(el => el.group === 'nodes' && el.data)
            .map(el => el.data)
            .filter(d => {
                const hit = s => typeof s === 'string' && s.toLowerCase().includes(q);
                if (hit(d.id) || hit(d.label) || hit(d.claim_text) || hit(d.description)) return true;
                return Object.values(d.metrics || {}).some(v => String(v).includes(q));
            }));
    }

    window.fetch = async function (input, init) {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) {
            return realFetch(input, init);
        }
        const method = ((init && init.method) || (input.method) || 'GET').toUpperCase();
        if (method !== 'GET') return json({ detail: READ_ONLY }, 403);

        const path = url.pathname;
        try {
            let m = path.match(/^\/api\/tasks\/([a-f0-9]+)\/search$/);
            if (m) return json(await search(m[1], url.searchParams.get('q') || ''));
            m = path.match(/^\/api\/tasks\/([a-f0-9]+)\/lineage\/(.+)$/);
            if (m) {
                const all = await load(`${m[1]}/lineage.json`);
                const hit = all[decodeURIComponent(m[2])];
                return hit ? json(hit) : json({ detail: 'Node not found' }, 404);
            }
            m = path.match(/^\/api\/tasks\/([a-f0-9]+)\/replay\/scores$/);
            if (m) {
                const all = await load(`${m[1]}/replay-scores.json`);
                const upto = url.searchParams.get('upto');
                return upto in all ? json(all[upto]) : json({ detail: 'No such replay step' }, 422);
            }
            const file = fileFor(path);
            if (!file) return json({ detail: 'Not part of the online demo.' }, 404);
            if (file.endsWith('.md')) return realFetch(DATA + file);
            return json(await load(file));
        } catch (e) {
            return json({ detail: 'Not part of the online demo.' }, 404);
        }
    };

    // The live stream: nothing will ever arrive, so never open one. The app sets its
    // handlers and waits; none of them fire.
    window.EventSource = function () { this.readyState = 2; };
    window.EventSource.prototype.close = function () {};
    window.EventSource.prototype.addEventListener = function () {};

    // Links into the API (the report's Markdown download) point at the exported file.
    document.addEventListener('click', ev => {
        const a = ev.target.closest && ev.target.closest('a[href^="/api/"]');
        if (!a) return;
        const file = fileFor(new URL(a.getAttribute('href'), location.href).pathname);
        if (file) a.setAttribute('href', DATA + file);
        else ev.preventDefault();
    }, true);

    // Say what this is, once, where the live/offline pill would be.
    document.addEventListener('DOMContentLoaded', () => {
        const pill = document.getElementById('conn-status');
        if (pill) {
            pill.textContent = 'demo';
            pill.dataset.state = 'demo';
            pill.title = 'A recorded run, read-only. Nothing streams here.';
        }
        const note = document.createElement('a');
        note.className = 'demo-note';
        note.href = MORE[0];
        if (/^https?:/.test(MORE[0])) {
            note.target = '_blank';
            note.rel = 'noopener';
        }
        note.textContent = `Online demo · read-only · ${MORE[1]} →`;
        document.body.prepend(note);
    });
})();
