/**
 * Load the client half exactly the way the browser does — register through
 * window.__ModuleLoader__, then run the factory with a React shim — so a module
 * that parses (node --check) but throws at load time is caught here, which is
 * what removes the whole panel from the sidebar.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

let moduleObj = null;
const sandbox = {
  window: { __ModuleLoader__: { load: (m) => { moduleObj = m; } } },
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'client.js' });

if (moduleObj === null) throw new Error('loader was never called');
console.log('registered:', moduleObj.id);

const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useEffect: () => {},
};

const result = moduleObj.factory((name) => {
  if (name === 'react') return react;
  throw new Error(`unexpected require: ${name}`);
});
console.log('factory returned:', result && Object.keys(result));
console.log('SMOKE OK');
