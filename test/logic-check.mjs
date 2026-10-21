/**
 * Offline checks over the shipped client half, in two families:
 *
 * - the pure helpers: row ordering, CSV export, timestamp shape;
 * - the colour wiring: every hue a bucket names is really defined, for both themes,
 *   and resolves to a platform static or a declared literal.
 *
 * Both read the shipped source text instead of re-implementing it, so the checks
 * describe the file the browser actually runs.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = new URL('../client.js', import.meta.url);
const src = readFileSync(SRC, 'utf8');

function slice(from, to) {
  const start = src.indexOf(from);
  if (start < 0) throw new Error(`missing start marker: ${from}`);
  const end = src.indexOf(to, start);
  if (end < start) throw new Error(`missing end marker after start: ${to}`);
  return src.slice(start, end);
}

let pass = 0;
const fails = [];
function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    return;
  }
  fails.push(detail === undefined ? name : `${name} — ${detail}`);
}

// --- 纯函数：从源码里取出来跑 ---
const countBlock = slice('function count(value) {', '\n\n');
const sortBlock = slice('const SORT_KEYS = {', '/** Local `YYYY-MM-DD HH:mm:ss`');
const csvBlock = slice('/** Local `YYYY-MM-DD HH:mm:ss`', '/**\n     * Hand one CSV');
const spanBlock = slice('function spanDays(rows, cap, floor) {', '/**\n     * Dense daily buckets');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${countBlock}\n${sortBlock}\n${csvBlock}\n${spanBlock}`, sandbox);
const { sortRows, toCsv, localStamp, spanDays } = vm.runInContext(
  '({ sortRows, toCsv, localStamp, spanDays })', sandbox,
);

const rows = [
  { key: 'a', time: 300, totalTokens: 10, latencyMs: 50, firstTokenMs: undefined, speed: undefined, title: 'beta', channel: 'x', model: 'model-x' },
  { key: 'b', time: 100, totalTokens: 30, latencyMs: undefined, firstTokenMs: 9, speed: 2, title: 'alpha', channel: 'y', model: 'm2' },
  { key: 'c', time: 200, totalTokens: 20, latencyMs: 10, firstTokenMs: undefined, speed: 5, title: 'gamma', channel: 'x', model: 'm3' },
];
const order = (list) => list.map((row) => row.key).join(',');

check('时间降序是默认序', order(sortRows(rows, { key: 'time', dir: 'desc' })) === 'a,c,b');
check('时间升序', order(sortRows(rows, { key: 'time', dir: 'asc' })) === 'b,c,a');
check('合计降序', order(sortRows(rows, { key: 'totalTokens', dir: 'desc' })) === 'b,c,a');
check('合计升序', order(sortRows(rows, { key: 'totalTokens', dir: 'asc' })) === 'a,c,b');
check('文本列升序', order(sortRows(rows, { key: 'title', dir: 'asc' })) === 'b,a,c');
check('文本列降序', order(sortRows(rows, { key: 'title', dir: 'desc' })) === 'c,a,b');

check('耗时降序: 未测量排最后', order(sortRows(rows, { key: 'latencyMs', dir: 'desc' })) === 'a,c,b');
check('耗时升序: 未测量仍排最后', order(sortRows(rows, { key: 'latencyMs', dir: 'asc' })) === 'c,a,b');
check('首字升序: 未测量仍排最后', order(sortRows(rows, { key: 'firstTokenMs', dir: 'asc' })) === 'b,a,c');
check('速度升序: 未测量仍排最后', order(sortRows(rows, { key: 'speed', dir: 'asc' })) === 'b,c,a');

const before = order(rows);
sortRows(rows, { key: 'totalTokens', dir: 'asc' });
check('不改动输入数组', order(rows) === before);
check('未知列原样返回', sortRows(rows, { key: 'nope', dir: 'desc' }) === rows);

const csv = toCsv(rows.slice(0, 2));
const lines = csv.split('\r\n');
check('CSV 表头 17 列', lines[0].split(',').length === 17, String(lines[0].split(',').length));
check('CSV 行数 = 表头 + 2', lines.length === 3, String(lines.length));
check('CSV 每个字段都带引号', lines[1].startsWith('"') && lines[1].endsWith('"'));
check('CSV 未测量导出为空字段', lines[2].includes('""'));
check('CSV 表头是中文', lines[0].includes('"合计"'));
check('CSV 用 CRLF 分行', csv.includes('\r\n'));

const tricky = toCsv([{ ...rows[0], time: 0, turn: 1, step: 1, title: 'a,b"c' }]);
check('CSV 转义引号且保留逗号', tricky.includes('"a,b""c"'), tricky.split('\r\n')[1]);

const stamp = localStamp(1700000000000);
check('localStamp 形状', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp), stamp);

// --- 配色接线 ---
const bucketBlock = slice('const BUCKETS = [', '\n\n');
const hueNames = [...bucketBlock.matchAll(/color: 'var\((--tu-[a-z-]+)\)'/g)].map((m) => m[1]);
const allTokens = [...src.matchAll(/'\s*(--tu-[a-z0-9-]+):/g)].map((m) => m[1]);

check('四个桶各有一个色名', hueNames.length === 4, hueNames.join(' '));
check('四桶四色互不相同', new Set(hueNames).size === 4, hueNames.join(' '));

for (const name of hueNames) {
  const occurrences = allTokens.filter((token) => token === name).length;
  check(`配色 ${name} 明暗各定义一次`, occurrences === 2, `出现 ${occurrences} 次`);
}

const cssBlock = slice('const LOCAL_CSS = [', "'  --tu-subtle:");
for (const name of hueNames) {
  const line = cssBlock.split('\n').find((text) => text.includes(`${name}:`));
  const resolved = line === undefined ? '' : line;
  check(
    `配色 ${name} 解析到平台色板或字面量`,
    /--dsw-static-[a-z0-9-]+|rgb\(/.test(resolved),
    resolved.trim(),
  );
}

// 趋势柱现在按桶堆叠，图例必须覆盖同样的四个桶
const trendBlock = slice("h(\n                'div',\n                { style: styles.plotBars },", "h(\n              'div',\n              { style: styles.chartAxis },");
check('趋势柱按桶堆叠', trendBlock.includes('flexGrow: point.buckets[bucket.key]'));
check('趋势图带图例', slice('styles.legend', 'legendSwatch').length > 0);

// --- 图表窗口跟随数据（spanDays）---
// 用当地正午构造，避开跨日边界对「第几天」的影响。
const atNoon = (daysAgo) => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(12, 0, 0, 0);
  return date.getTime();
};
const spanOf = (daysAgoList, cap, floor) => spanDays(daysAgoList.map((n) => ({ time: atNoon(n) })), cap, floor);

check('无数据时用下限', spanOf([], 30, 7) === 7, String(spanOf([], 30, 7)));
check('只有今天时用下限', spanOf([0], 30, 7) === 7, String(spanOf([0], 30, 7)));
check('11 天前起算得 12 天', spanOf([11], 30, 7) === 12, String(spanOf([11], 30, 7)));
check('正好铺满时不缩', spanOf([29], 30, 7) === 30, String(spanOf([29], 30, 7)));
check('超出上限时截到上限', spanOf([200], 30, 7) === 30, String(spanOf([200], 30, 7)));
check('取最早的那条', spanOf([5, 20, 3], 30, 7) === 21, String(spanOf([5, 20, 3], 30, 7)));
check('热力图 12 天数据用 28 天下限', spanOf([11], 365, 28) === 28, String(spanOf([11], 365, 28)));
check('热力图 200 天数据用 201', spanOf([200], 365, 28) === 201, String(spanOf([200], 365, 28)));
check('热力图超一年截到 365', spanOf([400], 365, 28) === 365, String(spanOf([400], 365, 28)));
check('上限不小于下限时仍自洽', spanOf([100], 7, 30) === 7, String(spanOf([100], 7, 30)));

console.log(`PASS ${pass} / ${pass + fails.length}`);
if (fails.length > 0) {
  console.log('FAIL:');
  for (const failure of fails) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
