// Preloaded into the server the e2e starts (node --import): records and blocks any outbound connection to a
// non-loopback address and writes the attempts to E2E_GUARD_FILE on exit. Same netguard the API tests use.
import fs from 'node:fs';
import { installNetguard } from '../server/test/netguard.js';

const g = installNetguard();
process.on('exit', () => { try { fs.writeFileSync(process.env.E2E_GUARD_FILE, JSON.stringify(g.attempts)); } catch { /* nothing to record */ } });
