// 条款裁撤引擎自检（不依赖测试框架）：
// 覆盖相邻标题、循环引用、多条同时删除、传递影响、各类拒绝与撤销事务。
import {
  analyzeRemoval,
  buildClauseBlocks,
  buildReferenceGraph,
  buildRemovalPlan,
  normalizeRemovalRequest,
} from '../src/removal';
import { initDB, createDocument, commitRenumber, undoLastRenumber, getDocument } from '../src/db';
import assert from 'node:assert';

let passed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    console.error(`  ❌ ${name}`);
    throw e;
  }
};

// 引用链：1 -> 2；2 -> 3、4；3 -> 4、1；5 无入边。
const CHAIN = [
  '服务合同',
  '',
  '第一条 总则',
  '本合同依据第二条确定的服务范围执行。',
  '第二条 服务范围',
  '服务范围见第三条，费用见第4条。',
  '第三条 费用',
  '费用按第4条支付，总则见第一条。',
  '第4条 支付',
  '支付方式另行约定。',
  '第五条 附则',
  '本条为附则，未被任何条款引用。',
].join('\n');

// ---------- 切块 ----------
console.log('removal/blocks:');
check('相邻标题各自成块：上一条区块只有标题一行', () => {
  const text = '第一条 甲\n第二条 乙\n第三条 丙\n正文引用第一条。';
  const blocks = buildClauseBlocks(text);
  assert.equal(blocks.length, 3);
  assert.deepEqual(
    blocks.map((b) => [b.startLine, b.endLine]),
    [
      [1, 1],
      [2, 2],
      [3, 4],
    ],
  );
  assert.equal(blocks[0].heading, '第一条 甲');
});

check('删除相邻标题中的一条：恰好切除标题行，下一条顶上', () => {
  const text = '第一条 甲\n第二条 乙\n第三条 丙\n正文引用第一条。';
  const plan = buildRemovalPlan(text, [2], []);
  assert.ok(plan.ok, JSON.stringify(plan.conflicts));
  assert.equal(plan.newText!, '第一条 甲\n第三条 丙\n正文引用第一条。');
  assert.equal(plan.removed![0].startLine, 2);
  assert.equal(plan.removed![0].endLine, 2);
});

check('删除首条：前言与后续条款保持完好，存活引用被改写', () => {
  // 第一条被第三条引用（第8行），未指定替代 -> 拒绝
  const denied = buildRemovalPlan(CHAIN, [1], []);
  assert.ok(!denied.ok);
  assert.ok(denied.conflicts!.some((c) => c.code === 'UNRESOLVED_REFERENCE'));

  const ok = buildRemovalPlan(CHAIN, [1], [{ from: 1, to: 5 }]);
  assert.ok(ok.ok, JSON.stringify(ok.conflicts));
  assert.ok(ok.newText!.startsWith('服务合同\n\n第二条 服务范围'), ok.newText!.split('\n')[2]);
  assert.ok(ok.newText!.includes('费用按第4条支付，总则见第五条。'));
});

// ---------- 引用图与影响 ----------
console.log('removal/impact:');
check('引用图边正确（含中文/阿拉伯混合编号）', () => {
  const blocks = buildClauseBlocks(CHAIN);
  const graph = buildReferenceGraph(blocks);
  assert.deepEqual(graph, [
    { from: 1, to: 2 },
    { from: 2, to: 3 },
    { from: 2, to: 4 },
    { from: 3, to: 1 },
    { from: 3, to: 4 },
  ]);
});

check('直接影响 + 沿引用链传递影响', () => {
  const result = analyzeRemoval(CHAIN, [4]);
  assert.ok(result.ok, JSON.stringify(result.conflicts));
  const { impact, requiredReplacements } = result.analysis!;
  // 直接：第二条、第三条 的正文引用了第4条
  assert.deepEqual(
    impact.direct.map((d) => d.number),
    [2, 3],
  );
  assert.equal(impact.direct[0].references.length, 1);
  assert.equal(impact.direct[0].references[0].pos.line, 6);
  // 传递：第一条 -> 第二条 -> 第4条
  assert.deepEqual(
    impact.transitive.map((t) => t.number),
    [1],
  );
  // 待办替代：第4条被存活文本引用 2 处
  assert.equal(requiredReplacements.length, 1);
  assert.equal(requiredReplacements[0].number, 4);
  assert.equal(requiredReplacements[0].references.length, 2);
});

check('无引用的条款可直接裁撤（无需替代映射）', () => {
  const result = analyzeRemoval(CHAIN, [5]);
  assert.ok(result.ok);
  assert.equal(result.analysis!.requiredReplacements.length, 0);
  assert.equal(result.analysis!.impact.direct.length, 0);

  const plan = buildRemovalPlan(CHAIN, [5], []);
  assert.ok(plan.ok, JSON.stringify(plan.conflicts));
  assert.equal(plan.changes!.length, 0);
  assert.ok(!plan.newText!.includes('第五条'));
  assert.ok(!plan.newText!.includes('附则'));
  assert.ok(plan.newText!.includes('第4条 支付'));
});

// ---------- 循环引用 ----------
console.log('removal/cycles:');
const CYCLE = [
  '第一条 甲',
  '适用第二条的约定。',
  '第二条 乙',
  '适用第一条的约定。',
  '第三条 丙',
  '内容。',
].join('\n');

check('循环引用：删除一环，另一环的引用必须映射', () => {
  const plan = buildRemovalPlan(CYCLE, [1], []);
  assert.ok(!plan.ok);
  const unresolved = plan.conflicts!.find((c) => c.code === 'UNRESOLVED_REFERENCE');
  assert.ok(unresolved, '应有 UNRESOLVED_REFERENCE');
  assert.equal(unresolved!.number, 1);
  assert.deepEqual(
    unresolved!.positions!.map((p) => p.line),
    [4],
  );

  const ok = buildRemovalPlan(CYCLE, [1], [{ from: 1, to: 3 }]);
  assert.ok(ok.ok, JSON.stringify(ok.conflicts));
  assert.ok(ok.newText!.includes('适用第三条的约定。'), '第二条的引用应改写为第三条');
  assert.ok(!ok.newText!.includes('第一条'));
});

check('循环引用：两环同时删除，块内互指引用无需映射', () => {
  const plan = buildRemovalPlan(CYCLE, [1, 2], []);
  assert.ok(plan.ok, JSON.stringify(plan.conflicts));
  assert.equal(plan.newText!, '第三条 丙\n内容。');
  assert.equal(plan.removed!.length, 2);
});

// ---------- 多条同时删除 ----------
console.log('removal/multi:');
check('多条同时删除：逐处改写可指向同一存活目标', () => {
  const plan = buildRemovalPlan(CHAIN, [3, 4], [
    { from: 3, to: 5 },
    { from: 4, to: 5 },
  ]);
  assert.ok(plan.ok, JSON.stringify(plan.conflicts));
  // 第二条的“第三条/第4条”两处引用都改写为第五条/第5条，风格各自保留
  assert.ok(plan.newText!.includes('服务范围见第五条，费用见第5条。'));
  // 第三条块内对第4条、第一条的引用随区块删除，不需要映射
  assert.ok(!plan.newText!.includes('费用按'));
  // 区块切除后文本保持连贯
  assert.ok(plan.newText!.includes('第二条 服务范围\n服务范围见第五条，费用见第5条。\n第五条 附则'));
  assert.equal(plan.removed!.length, 2);
  assert.equal(plan.changes!.length, 2);
});

check('多条同时删除：部分未映射即整体拒绝并给出位置', () => {
  const plan = buildRemovalPlan(CHAIN, [3, 4], [{ from: 3, to: 5 }]);
  assert.ok(!plan.ok);
  const unresolved = plan.conflicts!.find((c) => c.code === 'UNRESOLVED_REFERENCE');
  assert.ok(unresolved);
  assert.equal(unresolved!.number, 4);
  // 第8行的引用在待删的第三条块内，只有第6行的存活引用需要处理
  assert.deepEqual(
    unresolved!.positions!.map((p) => [p.line, p.column]),
    [[6, 13]],
  );
});

// ---------- 拒绝规则 ----------
console.log('removal/conflicts:');
check('替代目标也在删除集合 -> TARGET_IN_REMOVAL_SET 且带目标标题位置', () => {
  const plan = buildRemovalPlan(CHAIN, [3, 4], [{ from: 3, to: 4 }]);
  assert.ok(!plan.ok);
  const c = plan.conflicts!.find((x) => x.code === 'TARGET_IN_REMOVAL_SET');
  assert.ok(c);
  assert.equal(c!.number, 4);
  assert.deepEqual(c!.positions!.map((p) => p.line), [9]);
});

check('替代目标未定义 -> TARGET_NOT_DEFINED', () => {
  const plan = buildRemovalPlan(CHAIN, [4], [{ from: 4, to: 99 }]);
  assert.ok(!plan.ok);
  assert.ok(plan.conflicts!.some((c) => c.code === 'TARGET_NOT_DEFINED'));
});

check('待删编号未定义 -> NOT_DEFINED', () => {
  const plan = buildRemovalPlan(CHAIN, [42], []);
  assert.ok(!plan.ok);
  assert.ok(plan.conflicts!.some((c) => c.code === 'NOT_DEFINED' && c.number === 42));
});

check('待删编号重复定义 -> DUPLICATE_DEFINITION 且带全部标题位置', () => {
  const dup = '第一条 甲\n内容一。\n第一条 乙\n内容二。\n第二条 丙\n见第一条。';
  const plan = buildRemovalPlan(dup, [1], []);
  assert.ok(!plan.ok);
  const c = plan.conflicts!.find((x) => x.code === 'DUPLICATE_DEFINITION');
  assert.ok(c);
  assert.deepEqual(c!.positions!.map((p) => p.line), [1, 3]);
});

check('替代目标重复定义 -> DUPLICATE_DEFINITION', () => {
  const dup = '第一条 甲\n内容。\n第二条 乙\n见第一条。\n第二条 丙\n内容。';
  const plan = buildRemovalPlan(dup, [1], [{ from: 1, to: 2 }]);
  assert.ok(!plan.ok);
  assert.ok(plan.conflicts!.some((c) => c.code === 'DUPLICATE_DEFINITION' && c.number === 2));
});

check('替代映射的源不在删除集合 -> REPLACEMENT_SOURCE_NOT_REMOVED', () => {
  const plan = buildRemovalPlan(CHAIN, [5], [{ from: 2, to: 5 }]);
  assert.ok(!plan.ok);
  assert.ok(plan.conflicts!.some((c) => c.code === 'REPLACEMENT_SOURCE_NOT_REMOVED'));
});

check('请求规范化：空选择 / 非法行 / 重复替代源', () => {
  assert.ok(
    normalizeRemovalRequest({ numbers: [] }).errors.some((e) => e.code === 'EMPTY_SELECTION'),
  );
  assert.ok(
    normalizeRemovalRequest({ numbers: ['x'] }).errors.some((e) => e.code === 'INVALID_ROW'),
  );
  const dup = normalizeRemovalRequest({
    numbers: [1],
    replacements: [
      { from: 1, to: 2 },
      { from: 1, to: 3 },
    ],
  });
  assert.ok(dup.errors.some((e) => e.code === 'DUP_SOURCE'));
});

// ---------- 风格保留 ----------
console.log('removal/style:');
check('引用改写保留各自风格：中文归中文，阿拉伯归阿拉伯', () => {
  const text = '第一条 甲\n见第二条和第2条。\n第二条 乙\n内容。\n第三条 丙\n内容。';
  const plan = buildRemovalPlan(text, [2], [{ from: 2, to: 3 }]);
  assert.ok(plan.ok, JSON.stringify(plan.conflicts));
  assert.ok(plan.newText!.includes('见第三条和第3条。'));
});

// ---------- 事务与撤销 ----------
console.log('removal/db:');
check('裁撤提交与撤销在同一事务语义下工作（内存库）', () => {
  initDB(':memory:');
  const doc = createDocument('测试', CHAIN);
  const plan = buildRemovalPlan(CHAIN, [5], []);
  assert.ok(plan.ok);
  commitRenumber(
    doc.id,
    CHAIN,
    plan.newText!,
    JSON.stringify({ kind: 'removal', removed: [5], replacements: [] }),
    plan.removed!.length + plan.changes!.length,
  );
  assert.ok(!getDocument(doc.id)!.content.includes('第五条'));

  const undone = undoLastRenumber(doc.id);
  assert.ok(undone, '应能撤销裁撤');
  assert.equal(getDocument(doc.id)!.content, CHAIN);
  const parsed = JSON.parse(undone!.mapping);
  assert.equal(parsed.kind, 'removal');
  assert.deepEqual(parsed.removed, [5]);
});

console.log(`\n全部通过：${passed} 项 ✅`);
