// Server-Sent Events subscriber over fetch, as a browser EventSource or an
// API client consumes /api/v1/stream.

export function subscribe(url, { key, lastEventId } = {}) {
  const ac = new AbortController();
  const events = [];
  const sub = { events, status: null, error: null, closed: false };
  sub.done = (async () => {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'text/event-stream', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(lastEventId !== undefined && lastEventId !== null ? { 'Last-Event-ID': String(lastEventId) } : {}) },
        signal: ac.signal,
      });
      sub.status = res.status;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = {};
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) continue;
            const m = /^(\w+): ?(.*)$/.exec(line);
            if (m) ev[m[1]] = ev[m[1]] ? `${ev[m[1]]}\n${m[2]}` : m[2];
          }
          if (ev.event || ev.data) {
            try { ev.json = JSON.parse(ev.data); } catch { /* keep raw */ }
            events.push(ev);
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') sub.error = err.message;
    } finally {
      sub.closed = true;
    }
  })();
  sub.close = async () => { ac.abort(); await sub.done; };
  return sub;
}
