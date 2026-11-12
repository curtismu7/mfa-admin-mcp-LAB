// Records (and blocks) any outbound connection to a non-loopback address, from fetch or from a raw socket.
// Pattern from hostile-mcp (netguard), same author. Install once per test file; assert attempts is empty in after().
import net from 'node:net';

const LOOPBACK = (h) => h === undefined || h === null || h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(String(h).replace(/^\[|\]$/g, ''));

export function installNetguard() {
  const attempts = [];
  const realFetch = globalThis.fetch;
  const realConnect = net.Socket.prototype.connect;
  globalThis.fetch = (input, init) => {
    let host; try { host = new URL(typeof input === 'string' ? input : input.url).hostname; } catch { host = String(input); }
    if (!LOOPBACK(host)) { attempts.push({ via: 'fetch', host }); return Promise.reject(new TypeError(`netguard: blocked fetch to ${host}`)); }
    return realFetch(input, init);
  };
  net.Socket.prototype.connect = function patched(...args) {
    const a = Array.isArray(args[0]) ? args[0][0] : args[0]; // net normalises to [options, cb]
    let host;
    if (a && typeof a === 'object' && !Array.isArray(a)) host = a.path ? undefined : a.host;
    else if (typeof a === 'number') host = typeof args[1] === 'string' ? args[1] : undefined;
    if (!LOOPBACK(host)) { attempts.push({ via: 'socket', host }); throw new Error(`netguard: blocked socket to ${host}`); }
    return realConnect.apply(this, args);
  };
  return { attempts, restore() { globalThis.fetch = realFetch; net.Socket.prototype.connect = realConnect; } };
}
