// Offline guard for sw.js. 1.1.0 shipped with five modules missing from the
// precache list - backup.js, settings-schema.js, write-coalescer.js,
// alert-banner.js and voice-cues.js - and one import that fails fails the
// whole module graph, so the first offline open after that update showed the
// page with not one of its modules running. The list is kept by hand, and
// nothing complained when the imports outgrew it. This suite does.
//
// It runs the real install handler of sw.js against a fake Cache Storage and
// checks what actually got cached, and it finds what the page loads the way a
// browser does: every <script> in index.html, then every static import and
// re-export from the module entry points down.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const ROOT = new URL('../../', import.meta.url);
// Everything in the page and the worker is relative, so the origin it is
// served from does not matter (edgeloop.app, a GitHub Pages sub-path,
// localhost). Any origin stands in for it here.
const SITE = new URL('https://edgeloop.test/');
const PAGE_URL = new URL('index.html', SITE).href;
const SW_URL = new URL('sw.js', SITE).href;

// Modules under src/js that the page does not load, each with its reason.
// They are not precached either: sw.js holds what the page loads, and once
// the page imports one of them, the walk reaches it and the precache check
// below fails until sw.js names it.
const NOT_LOADED_BY_THE_PAGE = [
    './src/js/hrv.js' // the HRV display (H3) will import it
];

const readRepo = (relative) => readFileSync(new URL(relative, ROOT), 'utf8');
const sameOrigin = (url) => new URL(url).origin === SITE.origin;
const fileFor = (url) => new URL(`.${decodeURIComponent(new URL(url).pathname)}`, ROOT);
const shortName = (url) => (sameOrigin(url) ? `.${new URL(url).pathname}` : url);

// Every <script src> in the page, and whether the browser loads it as a module.
function pageScripts(html, pageUrl = PAGE_URL) {
    const scripts = [];
    for (const [tag] of String(html).matchAll(/<script\b[^>]*>/gi)) {
        const src = /\ssrc\s*=\s*["']([^"']+)["']/i.exec(tag);
        if (!src) continue;
        scripts.push({ url: new URL(src[1], pageUrl).href, module: /\stype\s*=\s*["']module["']/i.test(tag) });
    }
    return scripts;
}

// What a module asks the browser to load: `import ... from '...'`, a bare
// `import '...'`, `export ... from '...'`, and `import('...')` with a literal
// specifier, which is fetched later but must be there offline all the same.
// A declaration is only read where a statement starts (the start of a line,
// or after a semicolon), so one quoted in a // comment or on a block
// comment's `*` line is not mistaken for a real one. An `import('...')` in a
// comment, or an import-shaped line inside a string, still is: the reading
// errs towards finding too much, which fails this suite loudly, where a real
// import it could not see would pass it silently.
function importSpecifiers(source) {
    const text = String(source);
    const found = [];
    const declaration = /(?:^|;)[ \t]*(?:import|export)\b\s*(?:[\w$*{}\s,]*?\bfrom\s*)?(['"])([^'"\r\n]+)\1/gm;
    const dynamic = /\bimport\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g;
    for (const match of text.matchAll(declaration)) found.push(match[2]);
    for (const match of text.matchAll(dynamic)) found.push(match[2]);
    return found;
}

// The module graph the browser walks from the page's module scripts, as
// url -> the module that first imported it. A module on another origin is
// recorded but not walked: it has to be precached, and its own imports are
// its CDN's business.
function moduleGraph(entries) {
    const importedBy = new Map();
    const queue = entries.map((url) => ({ url, from: PAGE_URL }));
    while (queue.length > 0) {
        const { url, from } = queue.shift();
        if (importedBy.has(url)) continue;
        importedBy.set(url, from);
        if (!sameOrigin(url)) continue;
        const file = fileFor(url);
        assert.ok(existsSync(file), `${shortName(from)} imports ${shortName(url)}, which is not in the repository`);
        for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
            // A bare name ('lodash') needs an import map this app does not
            // have: the browser refuses it, online or not.
            assert.match(specifier, /^(?:\.{0,2}\/|[a-z][a-z\d+.-]*:)/i,
                `${shortName(url)} imports '${specifier}', which a browser cannot resolve without an import map`);
            queue.push({ url: new URL(specifier, url).href, from: url });
        }
    }
    return importedBy;
}

function thePage() {
    const scripts = pageScripts(readRepo('index.html'));
    const entries = scripts.filter((s) => s.module).map((s) => s.url);
    return { scripts, entries, graph: moduleGraph(entries) };
}

// Run the install handler of sw.js against a fake network and Cache Storage,
// and return what it stored (url -> response) and every url it asked the
// network for. The fake network is this repository on the site's origin, and
// CDNs that answer the way the real ones do: a no-cors request always gets an
// opaque reply, and a CORS request to the Tailwind CDN fails, because that
// CDN sends no Access-Control-Allow-Origin header. Cache.add is fetch + put
// and, like the real one, refuses any reply that is not ok - an opaque one
// included, whose status reads 0.
async function installWorker(source = readRepo('sw.js')) {
    const listeners = new Map();
    const stored = new Map();
    const requested = [];
    class FakeRequest {
        constructor(input, init = {}) {
            const fromRequest = input instanceof FakeRequest;
            this.url = new URL(fromRequest ? input.url : String(input), SW_URL).href;
            this.mode = init.mode || (fromRequest ? input.mode : 'cors');
        }
    }
    const toRequest = (input) => (input instanceof FakeRequest ? input : new FakeRequest(input));
    const fetch = async (input, init) => {
        const request = input instanceof FakeRequest && !init ? input : new FakeRequest(input, init);
        requested.push(request.url);
        if (sameOrigin(request.url)) {
            const ok = existsSync(fileFor(request.url));
            return { ok, status: ok ? 200 : 404, type: 'basic' };
        }
        if (request.mode === 'no-cors') return { ok: false, status: 0, type: 'opaque' };
        if (new URL(request.url).hostname === 'cdn.tailwindcss.com') throw new TypeError('Failed to fetch');
        return { ok: true, status: 200, type: 'cors' };
    };
    const cache = {
        async add(input) {
            const request = toRequest(input);
            const response = await fetch(request);
            if (!response.ok) throw new TypeError(`Cache.add refused ${request.url}: status ${response.status}`);
            stored.set(request.url, response);
        },
        async addAll(inputs) {
            await Promise.all(inputs.map((input) => cache.add(input)));
        },
        async put(input, response) {
            stored.set(toRequest(input).url, response);
        }
    };
    const context = {
        self: {
            location: new URL(SW_URL),
            addEventListener: (type, handler) => listeners.set(type, handler),
            skipWaiting: async () => {},
            clients: { claim: async () => {} }
        },
        caches: {
            open: async () => cache,
            keys: async () => [],
            delete: async () => true,
            match: async () => undefined
        },
        fetch,
        Request: FakeRequest,
        Response: { error: () => ({ type: 'error' }) },
        URL
    };
    runInNewContext(source, context, { filename: 'sw.js' });
    const install = listeners.get('install');
    assert.equal(typeof install, 'function', 'sw.js registers no install handler');
    let pending = null;
    install({ waitUntil: (promise) => { pending = promise; } });
    assert.ok(pending, 'the install handler must hand its work to event.waitUntil');
    await pending;
    return { stored, requested };
}

describe('importSpecifiers', () => {
    it('reads every form of import the browser follows', () => {
        const source = [
            "import { a } from './one.js';",
            'import {',
            '    b,',
            '    c as d',
            "} from './two.js';",
            'import def, * as ns from "./three.js";',
            "import './four.js';",
            "export * from './five.js';",
            "export { e } from './six.js'; import g from './seven.js';",
            "export * as h from '../eight.js';",
            "const later = () => import('./nine.js');"
        ].join('\n');
        assert.deepEqual(importSpecifiers(source), [
            './one.js', './two.js', './three.js', './four.js', './five.js', './six.js', './seven.js', '../eight.js', './nine.js'
        ]);
    });

    it('does not take a comment, a local export or import.meta for an import', () => {
        const source = [
            "// import { gone } from './commented-out.js';",
            '/*',
            " * import old from './in-a-block-comment.js';",
            ' */',
            "export const NOTE = 'import this from somewhere';",
            'export function from(x) { return x; }',
            "const here = new URL('./data.json', import.meta.url);"
        ].join('\n');
        assert.deepEqual(importSpecifiers(source), []);
    });
});

describe('pageScripts', () => {
    it('finds classic and module scripts, whatever order the attributes are in', () => {
        const html = [
            '<script src="https://cdn.example/lib.js"></script>',
            '<script>inline()</script>',
            '<script src="./src/a.js" type="module"></script>',
            "<script type='module' src='./src/b.js'></script>"
        ].join('\n');
        assert.deepEqual(pageScripts(html, 'https://site.test/index.html'), [
            { url: 'https://cdn.example/lib.js', module: false },
            { url: 'https://site.test/src/a.js', module: true },
            { url: 'https://site.test/src/b.js', module: true }
        ]);
    });
});

describe('the sw.js precache', () => {
    it('starts from a module entry point in index.html', () => {
        assert.ok(thePage().entries.length > 0, 'index.html loads no module script');
    });

    it('holds every module the page imports, however deep', async () => {
        const { graph } = thePage();
        const { stored } = await installWorker();
        const missing = [...graph]
            .filter(([url]) => !stored.has(url))
            .map(([url, from]) => `${shortName(url)} (imported by ${shortName(from)})`);
        assert.deepEqual(missing, [], 'add these to PRECACHE in sw.js: an offline open cannot start the app without them');
    });

    it('holds every other script index.html loads, the CDN ones included', async () => {
        const { scripts } = thePage();
        const { stored } = await installWorker();
        const missing = scripts.filter((s) => !s.module && !stored.has(s.url)).map((s) => shortName(s.url));
        assert.deepEqual(missing, [], 'add these to sw.js (PRECACHE_CDN when they come from another origin), or the page opens offline without them');
    });

    it('holds the page itself for an offline navigation', async () => {
        const { stored } = await installWorker();
        // The fetch handler answers a navigation it cannot reach with
        // ./index.html, and ./ is the manifest's start_url.
        assert.ok(stored.has(PAGE_URL), 'index.html is not precached');
        assert.ok(stored.has(new URL('./', SW_URL).href), './ is not precached');
    });

    it('asks for no file that is not in the repository', async () => {
        // Promise.allSettled keeps one 404 from failing the install, which
        // also means a renamed or deleted file left in the list is never
        // noticed there.
        const { requested } = await installWorker();
        const absent = requested.filter((url) => sameOrigin(url) && !existsSync(fileFor(url))).map(shortName);
        assert.deepEqual(absent, [], 'these PRECACHE entries name files that do not exist');
    });

    it('walks to every module under src/js, so no import went unread', () => {
        // Imports are read with a pattern, not a parser. If it ever misses
        // one, the module behind it drops out of the walk and the checks
        // above pass without it. So a module the walk cannot reach is either
        // dead code or an import that went unread, and both need a look.
        const { graph, scripts } = thePage();
        const walked = new Set([...graph.keys(), ...scripts.map((s) => s.url)].filter(sameOrigin).map(shortName));
        const modules = [];
        const collect = (dir) => {
            for (const entry of readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
                if (entry.isDirectory()) collect(`${dir}${entry.name}/`);
                else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) modules.push(`./${dir}${entry.name}`);
            }
        };
        collect('src/js/');
        const unreached = modules.filter((m) => !walked.has(m) && !NOT_LOADED_BY_THE_PAGE.includes(m));
        assert.deepEqual(unreached, []);
    });

    it('names exactly the modules 1.1.0 left out, given the list it shipped', async () => {
        // The same check against the worker as it was released, which had
        // those five lines missing: it has to find all five, and nothing else.
        const leftOut = ['alert-banner', 'backup', 'settings-schema', 'voice-cues', 'write-coalescer'];
        const released = readRepo('sw.js').replace(new RegExp(`'\\./src/js/(?:${leftOut.join('|')})\\.js',?\\s*`, 'g'), '');
        assert.notEqual(released, readRepo('sw.js'), 'the entries this test removes are not in sw.js any more');
        const { graph } = thePage();
        const { stored } = await installWorker(released);
        const missing = [...graph.keys()].filter((url) => !stored.has(url)).map(shortName).sort();
        const expected = leftOut.map((name) => `./src/js/${name}.js`).filter((m) => graph.has(new URL(m, SITE).href));
        assert.deepEqual(missing, expected);
    });
});
