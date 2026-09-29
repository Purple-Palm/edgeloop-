// Offline guard for an update of sw.js. The worker keeps a copy of every file
// it serves, but only in the cache its CACHE_VERSION names, and a worker with
// another version deletes that cache when it activates. A module the precache
// list leaves out then has no copy left, and one import that fails fails the
// whole module graph, so the next offline open runs not one module.
//
// 1.1.0 and 1.1.2 ship the same worker: its cache is edgeloop-v4, and its list
// leaves five of the page's modules out. This worker names another cache, so
// the online visit on which a returning visitor takes it up also deletes
// edgeloop-v4, and the next offline open can count only on what this worker
// precached. precache.test.js checks what the install handler stores on a
// first visit; this suite runs the real install, activate and fetch handlers
// of sw.js against a fake network and Cache Storage for a visitor who arrives
// with edgeloop-v4, and finds what the page loads the way a browser does: the
// module scripts in index.html, then every import from there down.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const ROOT = new URL('../../', import.meta.url);
// Everything in the page and the worker is relative, so any origin stands in
// for edgeloop.app here.
const SITE = new URL('https://edgeloop.test/');
const PAGE_URL = new URL('index.html', SITE).href;
const SW_URL = new URL('sw.js', SITE).href;

// The cache the worker of 1.1.0 and 1.1.2 keeps its copies in. A visitor who
// has opened either has this cache and no other.
const RELEASED_CACHE = 'edgeloop-v4';

// The modules the page imports that the precache list of 1.1.0 and 1.1.2 was
// shipped without. This worker's list names all five; the check that the
// update can fail takes them off it again.
const LEFT_OUT_BY_1_1_0 = ['settings-schema.js', 'write-coalescer.js', 'backup.js', 'alert-banner.js', 'voice-cues.js'];

const readRepo = (relative) => readFileSync(new URL(relative, ROOT), 'utf8');
const sameOrigin = (url) => new URL(url).origin === SITE.origin;
const shortName = (url) => (sameOrigin(url) ? `.${new URL(url).pathname}` : url);
const leftOutBy110 = (url) => LEFT_OUT_BY_1_1_0.some((name) => shortName(url) === `./src/js/${name}`);

// The file the site serves for a same-origin URL: a directory is served its
// index.html.
function fileFor(url) {
    const { pathname } = new URL(url);
    return new URL(`.${decodeURIComponent(pathname)}${pathname.endsWith('/') ? 'index.html' : ''}`, ROOT);
}

// The URLs of the module scripts in the page, whatever order their attributes
// are written in.
function moduleEntries(html, pageUrl = PAGE_URL) {
    const entries = [];
    for (const [tag] of String(html).matchAll(/<script\b[^>]*>/gi)) {
        const src = /\ssrc\s*=\s*["']([^"']+)["']/i.exec(tag);
        if (src && /\stype\s*=\s*["']module["']/i.test(tag)) entries.push(new URL(src[1], pageUrl).href);
    }
    return entries;
}

// What a module asks the browser to fetch: `import ... from '...'`, a bare
// `import '...'`, `export ... from '...'`, and `import('...')` with a literal
// specifier, which is fetched later but has to be there offline all the same.
// A declaration is only read where a statement can start (the start of a line,
// or after a semicolon), so one quoted in a // comment or on a block comment's
// `*` line is not taken for a real one. The reading errs towards finding too
// much: an import it makes up names a file that is not there and fails this
// suite loudly, where a real one it missed would pass it silently.
function importSpecifiers(source) {
    const text = String(source);
    const declaration = /(?:^|;)[ \t]*(?:import|export)\b\s*(?:[\w$*{}\s,]*?\bfrom\s*)?(['"])([^'"\r\n]+)\1/gm;
    const dynamic = /\bimport\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g;
    return [...text.matchAll(declaration), ...text.matchAll(dynamic)].map((match) => match[2]);
}

// Every module the page loads, from its module scripts down, in the order a
// browser first asks for them. The imports are read the way precache.test.js
// reads them, and that suite fails when the reading misses a module under
// src/js, which would let the checks below pass without it.
function pageModules() {
    const seen = new Set();
    const queue = moduleEntries(readRepo('index.html'));
    assert.ok(queue.length > 0, 'index.html loads no module script');
    while (queue.length > 0) {
        const url = queue.shift();
        if (seen.has(url)) continue;
        seen.add(url);
        // A module on another origin has to be cached like any other, but its
        // own imports are its host's business.
        if (!sameOrigin(url)) continue;
        const file = fileFor(url);
        assert.ok(existsSync(file), `the page imports ${shortName(url)}, which is not in the repository`);
        for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) queue.push(new URL(specifier, url).href);
    }
    return [...seen];
}

// A network and a Cache Storage that behave like a browser's wherever sw.js
// relies on them. fetch() answers from this repository while `online` is set
// and rejects, as a browser does, once it is not; a file that is not there is
// a 404. A cross-origin request made no-cors, the way a <script> tag makes it,
// gets an opaque reply. Cache.add is fetch + put and refuses a reply that is
// not ok. caches.match looks through every cache in the order they were made,
// as the real one does, and ignoreSearch leaves the query out on both sides.
function fakeBrowser() {
    class Request {
        constructor(input, init = {}) {
            const from = input instanceof Request ? input : null;
            this.url = new URL(from ? from.url : String(input), SW_URL).href;
            this.method = init.method || (from ? from.method : 'GET');
            this.mode = init.mode || (from ? from.mode : 'cors');
        }
    }
    class Response {
        constructor({ url = '', status = 200, type = 'basic', body = '' } = {}) {
            Object.assign(this, { url, status, type, body, ok: status >= 200 && status <= 299 });
        }
        clone() {
            return new Response(this);
        }
        static error() {
            return new Response({ status: 0, type: 'error' });
        }
    }
    const toRequest = (input) => (input instanceof Request ? input : new Request(input));
    const keyOf = (input, ignoreSearch = false) => {
        const url = new URL(toRequest(input).url);
        if (ignoreSearch) url.search = '';
        return url.href;
    };
    const browser = { online: true, Request, Response };
    browser.fetch = async (input, init) => {
        const request = init ? new Request(input, init) : toRequest(input);
        if (!browser.online) throw new TypeError('Failed to fetch');
        if (!sameOrigin(request.url)) {
            return request.mode === 'no-cors'
                ? new Response({ url: request.url, status: 0, type: 'opaque' })
                : new Response({ url: request.url, type: 'cors' });
        }
        const file = fileFor(request.url);
        if (!existsSync(file) || !statSync(file).isFile()) return new Response({ url: request.url, status: 404 });
        return new Response({ url: request.url, body: readFileSync(file, 'utf8') });
    };
    const stores = new Map();
    const cacheNamed = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        const entries = stores.get(name);
        const cache = {
            async put(input, response) {
                entries.set(keyOf(input), response);
            },
            async add(input) {
                const response = await browser.fetch(toRequest(input));
                if (!response.ok) throw new TypeError(`Cache.add refused ${keyOf(input)}: status ${response.status}`);
                entries.set(keyOf(input), response);
            },
            async addAll(inputs) {
                await Promise.all(inputs.map((input) => cache.add(input)));
            },
            async match(input, { ignoreSearch = false } = {}) {
                const wanted = keyOf(input, ignoreSearch);
                for (const [url, response] of entries) {
                    if (keyOf(url, ignoreSearch) === wanted) return response.clone();
                }
                return undefined;
            },
            async keys() {
                return [...entries.keys()].map((url) => new Request(url));
            }
        };
        return cache;
    };
    browser.caches = {
        async open(name) {
            return cacheNamed(name);
        },
        async has(name) {
            return stores.has(name);
        },
        async keys() {
            return [...stores.keys()];
        },
        async delete(name) {
            return stores.delete(name);
        },
        async match(input, options) {
            for (const name of [...stores.keys()]) {
                const found = await cacheNamed(name).match(input, options);
                if (found) return found;
            }
            return undefined;
        }
    };
    return browser;
}

// Load a worker script the way the browser does and hand back its events.
// install and activate wait for whatever the handlers gave event.waitUntil();
// fetch returns what the handler gave event.respondWith(), or goes to the
// network itself when the handler lets the request through, and a fetch that
// fails is the network error the page would get.
function startWorker(browser, source = readRepo('sw.js')) {
    const listeners = [];
    runInNewContext(source, {
        self: {
            location: new URL(SW_URL),
            addEventListener: (type, handler) => listeners.push({ type, handler }),
            skipWaiting: async () => {},
            clients: { claim: async () => {} }
        },
        caches: browser.caches,
        fetch: browser.fetch,
        Request: browser.Request,
        Response: browser.Response,
        URL
    }, { filename: 'sw.js' });
    const handlers = (type) => listeners.filter((l) => l.type === type).map((l) => l.handler);
    const lifecycle = async (type) => {
        for (const handler of handlers(type)) {
            let pending = null;
            handler({ waitUntil: (promise) => { pending = promise; } });
            assert.ok(pending, `the ${type} handler must hand its work to event.waitUntil`);
            await pending;
        }
    };
    return {
        install: () => lifecycle('install'),
        activate: () => lifecycle('activate'),
        async fetch(url, { mode = 'cors' } = {}) {
            const request = new browser.Request(url, { mode });
            let answer = null;
            for (const handler of handlers('fetch')) {
                handler({ request, respondWith: (promise) => { answer = answer || promise; } });
            }
            try {
                return (await (answer || browser.fetch(request))) || browser.Response.error();
            } catch {
                return browser.Response.error();
            }
        }
    };
}

// A visitor who has opened 1.1.0 or 1.1.2 opens this version once online,
// which is the visit on which the browser finds the changed sw.js, installs it
// and lets it take over; then the network goes. Returns the modules of the
// page the worker cannot serve any more.
async function lostOnUpdateFrom110(source) {
    const modules = pageModules();
    const browser = fakeBrowser();
    // The released worker is the one that served that visit, and its fetch
    // handler kept a copy of every file it served, in its own cache.
    const released = await browser.caches.open(RELEASED_CACHE);
    for (const url of [new URL('./', SITE).href, PAGE_URL, ...modules]) {
        await released.put(url, await browser.fetch(url));
    }
    const worker = startWorker(browser, source);
    await worker.install();
    await worker.activate();
    browser.online = false;
    const lost = [];
    for (const url of modules) {
        if ((await worker.fetch(url)).type === 'error') lost.push(shortName(url));
    }
    const page = await worker.fetch(new URL('./', SITE).href, { mode: 'navigate' });
    if (page.type === 'error') lost.unshift('./ (the page itself)');
    return lost;
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
        assert.deepEqual(importSpecifiers(source).sort(), [
            '../eight.js', './five.js', './four.js', './nine.js', './one.js', './seven.js', './six.js', './three.js', './two.js'
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

describe('moduleEntries', () => {
    it('finds the module scripts, whatever order the attributes are in, and nothing else', () => {
        const html = [
            '<script src="https://cdn.example/lib.js"></script>',
            '<script>inline()</script>',
            '<script src="./src/a.js" type="module"></script>',
            "<script type='module' src='./src/b.js'></script>"
        ].join('\n');
        assert.deepEqual(moduleEntries(html, 'https://site.test/index.html'), [
            'https://site.test/src/a.js',
            'https://site.test/src/b.js'
        ]);
    });
});

describe('an update of sw.js, for a visitor who has opened 1.1.0 or 1.1.2', () => {
    it('keeps every module the page imports for the next offline open', async () => {
        assert.deepEqual(await lostOnUpdateFrom110(), [],
            'an offline open cannot start the app without these: add them to PRECACHE in sw.js');
    });

    it('would lose exactly the modules 1.1.0 left out, given the list it shipped', async () => {
        // The check above has to be able to fail. The same update with the
        // five modules 1.1.0 left out taken off the list again must lose those
        // five and nothing else: the page itself and every module the list
        // still names come from the new cache. The cache is renamed here as
        // well, so the old one goes on activate whatever CACHE_VERSION says.
        const source = readRepo('sw.js');
        const escaped = LEFT_OUT_BY_1_1_0.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const renamed = source
            .replace(/const CACHE_VERSION = '[^']*';/, "const CACHE_VERSION = 'edgeloop-renamed';")
            .replace(new RegExp(`'\\./src/js/(?:${escaped.join('|')})',?\\s*`, 'g'), '');
        assert.match(renamed, /const CACHE_VERSION = 'edgeloop-renamed';/, 'sw.js no longer declares CACHE_VERSION the way this test renames it');
        const expected = pageModules().filter(leftOutBy110).map(shortName).sort();
        assert.equal(expected.length, LEFT_OUT_BY_1_1_0.length, 'the page no longer imports every module named in LEFT_OUT_BY_1_1_0');
        assert.deepEqual((await lostOnUpdateFrom110(renamed)).sort(), expected);
    });
});
