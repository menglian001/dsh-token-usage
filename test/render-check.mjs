/**
 * Render check for the 合计 composition bar.
 *
 * Extracts `totalCell` and the real BUCKETS from the shipped source, runs it with a
 * minimal createElement shim, and inspects the returned element tree — so a bar that
 * only looks right in the source cannot pass.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const slice = (from, to) => {
  const start = src.indexOf(from);
  if (start < 0) throw new Error(`missing start marker: ${from}`);
  const end = src.indexOf(to, start);
  if (end < start) throw new Error(`missing end marker after start: ${to}`);
  return src.slice(start, end);
};

const helpers = slice('function count(value) {', 'function stamp(time) {');
const buckets = slice('const BUCKETS = [', '\n\n');
const cell = slice('function totalCell(source) {', '    function requestRow(');

const h = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
});
const styles = {
  td: { textAlign: 'right' },
  strong: { fontWeight: 600 },
  stackCell: { display: 'inline-flex' },
  compose: { display: 'flex', width: 54 },
  composeSeg: { flexBasis: 0 },
};

const sandbox = { h, styles };
vm.createContext(sandbox);
vm.runInContext(`${helpers}\n${buckets}\n${cell}`, sandbox);
const { totalCell, BUCKETS } = vm.runInContext('({ totalCell, BUCKETS })', sandbox);

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
  if (ok) { pass += 1; return; }
  fails.push(detail === undefined ? name : `${name} — ${detail}`);
};

const zero = { totalTokens: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
const mixed = { totalTokens: 1000, uncachedInputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 50, outputTokens: 50 };
const fullPrice = { totalTokens: 500, uncachedInputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };

const tdOf = (source) => totalCell(source);
const stackOf = (td) => td.children[0];
const barOf = (td) => stackOf(td).children[1];

// --- 单元格骨架 ---
const td = tdOf(mixed);
check('是 td', td.type === 'td');
check('保留 strong 样式', td.props.style.fontWeight === 600, JSON.stringify(td.props.style));
check('td 的 title 是精确合计', td.props.title === '1,000', td.props.title);
check('内容是一个 stackCell span', stackOf(td).type === 'span' && stackOf(td).props.style === styles.stackCell);
check('数字在条上面', typeof stackOf(td).children[0] === 'string' || typeof stackOf(td).children[0] === 'number');

// --- 有用量：四段构成条 ---
const bar = barOf(td);
check('构成条用 compose 样式', bar.props.style === styles.compose);
check('四个桶各一段', bar.children.length === 4, String(bar.children.length));
check('每段都是 span', bar.children.every((seg) => seg.type === 'span'));
check('每段带 flexGrow', bar.children.every((seg) => typeof seg.props.style.flexGrow === 'number'));
check(
  'flexGrow 等于该桶 token 数',
  bar.children.map((seg) => seg.props.style.flexGrow).join(',') === '100,800,50,50',
  bar.children.map((seg) => seg.props.style.flexGrow).join(','),
);
check(
  '每段用对应桶的颜色',
  bar.children.map((seg) => seg.props.style.background).join(',')
    === BUCKETS.map((bucket) => bucket.color).join(','),
);
check('段色名与 BUCKETS 一致', BUCKETS.length === 4 && new Set(BUCKETS.map((b) => b.color)).size === 4);
check('条上有四项明细 tooltip', bar.props.title.includes('缓存读 800'), bar.props.title);

// --- 单桶：只画一段 ---
const single = barOf(tdOf(fullPrice));
check('单桶只画一段', single.children.length === 1, String(single.children.length));
check('单桶段色是未命中色', single.children[0].props.style.background === BUCKETS[0].color);

// --- 零用量：不画条 ---
const zeroTd = tdOf(zero);
check('零用量只有数字没有条', stackOf(zeroTd).children.length === 1, String(stackOf(zeroTd).children.length));
check('零用量仍保留数字', typeof stackOf(zeroTd).children[0] === 'string' || typeof stackOf(zeroTd).children[0] === 'number');
check('零用量 title 是 0', zeroTd.props.title === '0', zeroTd.props.title);

console.log(`PASS ${pass} / ${pass + fails.length}`);
if (fails.length > 0) {
  console.log('FAIL:');
  for (const failure of fails) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
