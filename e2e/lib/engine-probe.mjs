// Preloaded into the engine process by the release gate (node --import).
// It only observes: every 500 ms it records the process's resident set size
// and CPU time, and it records every outbound HTTP request the engine makes
// (fetch, http.request, https.request) so the gate can prove which paths
// stay off the network. It changes no behaviour of the engine.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const file = process.env.NOMUS_GATE_PROBE_FILE;
if (file) {
  const write = (obj) => {
    try { fs.appendFileSync(file, `${JSON.stringify(obj)}\n`); } catch { /* the gate reads what it can */ }
  };

  const sample = () => {
    const cpu = process.cpuUsage();
    write({ kind: 'res', t: Date.now(), rss: process.memoryUsage.rss(), cpuUserUs: cpu.user, cpuSystemUs: cpu.system });
  };
  sample();
  setInterval(sample, 500).unref();

  const net = (url, via) => {
    let host = '';
    try { host = new URL(String(url)).hostname; } catch { /* unparseable */ }
    write({ kind: 'net', t: Date.now(), via, url: String(url).slice(0, 300), host });
  };

  const origFetch = globalThis.fetch;
  if (origFetch) {
    globalThis.fetch = function gateFetch(input, init) {
      const url = typeof input === 'string' || input instanceof URL ? input : input?.url;
      net(url, 'fetch');
      return origFetch.call(this, input, init);
    };
  }

  const wrap = (mod, name, scheme) => {
    for (const fn of ['request', 'get']) {
      const orig = mod[fn];
      mod[fn] = function gateRequest(...args) {
        const a = args[0];
        let url;
        if (typeof a === 'string' || a instanceof URL) url = String(a);
        else if (a && typeof a === 'object') url = `${scheme}//${a.hostname ?? a.host ?? 'localhost'}${a.port ? `:${a.port}` : ''}${a.path ?? '/'}`;
        net(url, `${name}.${fn}`);
        return orig.apply(this, args);
      };
    }
  };
  wrap(http, 'http', 'http:');
  wrap(https, 'https', 'https:');
  syncBuiltinESMExports();
}
