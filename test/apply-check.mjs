/**
 * Run the client half's `apply(ctx)` against a stub context.
 *
 * The sidebar entry is registered inside apply, so an apply that throws removes
 * every slot this plugin owns at once — the symptom is the whole panel vanishing
 * from the sidebar while the module itself still parses and loads.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

let moduleObj = null;
const sandbox = { window: { __ModuleLoader__: { load: (m) => { moduleObj = m; } } } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'client.js' });

const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useEffect: () => {},
};

const plugin = moduleObj.factory((name) => {
  if (name === 'react') return react;
  throw new Error(`unexpected require: ${name}`);
});

const registered = [];
const ctx = {
  slots: {
    inject: (slot, factory) => {
      registered.push(`inject:${slot}`);
      factory();
      return () => {};
    },
    register: (options, component) => {
      registered.push(`register:${options.name}:${options.id ?? options.key}:${typeof component}`);
      return () => {};
    },
  },
  get: () => undefined,
  effect: (fn) => {
    fn();
    return () => {};
  },
  on: () => () => {},
};

try {
  const dispose = plugin.apply(ctx);
  console.log('APPLY OK');
  console.log('registrations:');
  for (const line of registered) console.log(`  ${line}`);
  if (typeof dispose === 'function') {
    dispose();
    console.log('DISPOSE OK');
  }
} catch (error) {
  console.error('APPLY FAIL:', error && error.message);
  console.error(error && error.stack);
  process.exitCode = 1;
}
