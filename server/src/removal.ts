// 条款裁撤引擎。
//
// 与改号引擎同构，分三步：
//   1) 切块：按“标题行”把合同切成条款区块（标题行起点 -> 下一标题行起点），
//      相邻标题各自成块（上一条的区块可以只有标题一行）；
//   2) 建图：块内出现的“第X条”引用构成 条款 -> 条款 的引用图，
//      据此给出直接引用待删条款的位置，以及沿引用链反向可达的受影响条款；
//   3) 校验 + 单遍重建：存活文本中每个指向待删条款的引用都必须有替代目标，
//      删除区块整体切除、存活引用按映射改写，全部写入独立缓冲，顺序无关。
//
// 任何冲突都在写入前校验，冲突即整体拒绝并携带行/列位置，绝不部分写入。

import {
  analyzeText,
  buildLineStarts,
  posAt,
  type ClauseOccurrence,
  type TextPos,
} from './parser';
import { renderClauseNumber } from './numerals';
import { snippetAround, type ChangeItem, type MappingEntry } from './renumber';

// ---------- 类型 ----------

export interface ClauseBlock {
  number: number;
  heading: string; // 标题行文本（去掉前导空白）
  headingPos: TextPos;
  startOffset: number; // 标题行起点
  endOffset: number; // 排他：下一标题行起点或文末
  startLine: number;
  endLine: number; // 含
  references: number[]; // 块内引用到的编号（按出现顺序，去重）
}

export interface RemovedBlockDTO {
  number: number;
  heading: string;
  startLine: number;
  endLine: number;
  text: string; // 将被删除的原文区块
}

export interface ImpactReferenceDTO {
  number: number; // 指向的待删编号
  pos: TextPos;
  line: string; // 引用所在行文本
}

export interface DirectImpactDTO {
  /** 受影响的存活条款编号；null 表示首个标题之前的“前言”区域 */
  number: number | null;
  heading: string;
  headingLine: number | null;
  references: ImpactReferenceDTO[]; // 该区域内指向待删条款的全部引用
}

export interface TransitiveImpactDTO {
  number: number;
  heading: string;
  headingLine: number;
}

export interface RemovalImpactDTO {
  direct: DirectImpactDTO[];
  transitive: TransitiveImpactDTO[];
}

export interface ReferenceEdgeDTO {
  from: number;
  to: number;
}

export interface RequiredReplacementDTO {
  number: number; // 待删编号
  references: { pos: TextPos; line: string; clause: number | null }[];
}

export interface RemovalAnalysisDTO {
  removed: RemovedBlockDTO[];
  impact: RemovalImpactDTO;
  /** 仍被存活文本引用的待删编号：提交前必须逐一给出替代目标 */
  requiredReplacements: RequiredReplacementDTO[];
  /** 全文档条款引用图（去重后的边） */
  graph: ReferenceEdgeDTO[];
}

export interface RemovalPlanResult {
  ok: boolean;
  conflicts?: RemovalConflict[];
  removed?: RemovedBlockDTO[];
  impact?: RemovalImpactDTO;
  replacements?: MappingEntry[];
  changes?: ChangeItem[]; // 逐处引用改写
  newText?: string;
}

export type RemovalConflictCode =
  | 'EMPTY_SELECTION'
  | 'INVALID_ROW'
  | 'DUP_SOURCE'
  | 'NOT_DEFINED'
  | 'DUPLICATE_DEFINITION'
  | 'TARGET_NOT_DEFINED'
  | 'TARGET_IN_REMOVAL_SET'
  | 'REPLACEMENT_SOURCE_NOT_REMOVED'
  | 'UNRESOLVED_REFERENCE';

export interface RemovalConflict {
  code: RemovalConflictCode;
  message: string;
  number?: number;
  positions?: TextPos[];
}

// ---------- 请求规范化 ----------

const positiveInt = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^[0-9]+$/.test(v.trim())) return Number(v.trim());
  return null;
};

/** 来自客户端的原始请求 -> 规范化的删除集合与替代映射；逐行报告输入层面的错误。 */
export function normalizeRemovalRequest(body: unknown): {
  numbers: number[];
  replacements: MappingEntry[];
  errors: RemovalConflict[];
} {
  const errors: RemovalConflict[] = [];
  const raw = (body ?? {}) as { numbers?: unknown; replacements?: unknown };

  const numbers: number[] = [];
  if (!Array.isArray(raw.numbers) || raw.numbers.length === 0) {
    errors.push({
      code: 'EMPTY_SELECTION',
      message: '未选择任何条款：请至少勾选一个待裁撤的条款。',
    });
  } else {
    raw.numbers.forEach((v, idx) => {
      const n = positiveInt(v);
      if (n === null) {
        errors.push({
          code: 'INVALID_ROW',
          message: `删除集合第 ${idx + 1} 项：条款编号必须是正整数（收到 ${JSON.stringify(v)}）。`,
        });
      } else if (!numbers.includes(n)) {
        numbers.push(n);
      }
    });
  }

  const replacements: MappingEntry[] = [];
  const repSource = new Set<number>();
  if (raw.replacements !== undefined) {
    if (!Array.isArray(raw.replacements)) {
      errors.push({ code: 'INVALID_ROW', message: 'replacements 必须是数组。' });
    } else {
      raw.replacements.forEach((row, idx) => {
        if (row === null || typeof row !== 'object') {
          errors.push({ code: 'INVALID_ROW', message: `替代映射第 ${idx + 1} 行：格式无效。` });
          return;
        }
        const from = positiveInt((row as { from?: unknown }).from);
        const to = positiveInt((row as { to?: unknown }).to);
        if (from === null || to === null) {
          errors.push({
            code: 'INVALID_ROW',
            message: `替代映射第 ${idx + 1} 行：待删编号与替代目标都必须是正整数。`,
          });
          return;
        }
        if (repSource.has(from)) {
          errors.push({
            code: 'DUP_SOURCE',
            message: `待删编号 ${from} 的替代目标被指定了多次（替代映射第 ${idx + 1} 行）。`,
            number: from,
          });
          return;
        }
        repSource.add(from);
        replacements.push({ from, to });
      });
    }
  }

  return { numbers, replacements, errors };
}

// ---------- 切块与引用图 ----------

function lineTextAt(text: string, lineStarts: number[], offset: number): string {
  const pos = posAt(offset, lineStarts);
  const from = lineStarts[pos.line - 1];
  const nl = text.indexOf('\n', from);
  return text.slice(from, nl === -1 ? text.length : nl).replace(/^[ \t　]+/, '');
}

/** 把全文切成条款区块：标题行起点 -> 下一标题行起点（或文末）。 */
export function buildClauseBlocks(
  text: string,
  occurrences?: ClauseOccurrence[],
): ClauseBlock[] {
  const occs = occurrences ?? analyzeText(text).occurrences;
  const lineStarts = buildLineStarts(text);
  const defs = occs.filter((o) => o.kind === 'definition');

  return defs.map((def, i) => {
    const startOffset = lineStarts[def.pos.line - 1];
    const endOffset = i + 1 < defs.length ? lineStarts[defs[i + 1].pos.line - 1] : text.length;
    const references: number[] = [];
    for (const o of occs) {
      if (o.kind !== 'reference' || o.start < startOffset || o.start >= endOffset) continue;
      if (!references.includes(o.number)) references.push(o.number);
    }
    return {
      number: def.number,
      heading: lineTextAt(text, lineStarts, startOffset),
      headingPos: def.pos,
      startOffset,
      endOffset,
      startLine: def.pos.line,
      endLine: posAt(endOffset - 1, lineStarts).line,
      references,
    };
  });
}

/** 条款引用图：块内引用构成 条款 -> 条款 的有向边（去重、按编号排序）。 */
export function buildReferenceGraph(blocks: ClauseBlock[]): ReferenceEdgeDTO[] {
  const edges = new Set<string>();
  for (const b of blocks) {
    for (const to of b.references) edges.add(`${b.number}:${to}`);
  }
  return [...edges]
    .map((e) => {
      const [from, to] = e.split(':').map(Number);
      return { from, to };
    })
    .sort((a, b) => a.from - b.from || a.to - b.to);
}

/** 引用出现的“容器”：所在条款区块编号；首个标题之前返回 null。 */
function containerOf(blocks: ClauseBlock[], offset: number): ClauseBlock | null {
  let found: ClauseBlock | null = null;
  for (const b of blocks) {
    if (b.startOffset <= offset && offset < b.endOffset) return b;
    if (b.startOffset <= offset) found = b;
  }
  return found;
}

// ---------- 影响分析 ----------

interface ImpactContext {
  text: string;
  blocks: ClauseBlock[];
  occurrences: ClauseOccurrence[];
  deleted: Set<number>;
}

function buildImpact(ctx: ImpactContext): RemovalImpactDTO {
  const { text, blocks, occurrences, deleted } = ctx;
  const lineStarts = buildLineStarts(text);

  // 直接影响：存活区域中实际含有指向待删条款引用的条款（或前言）。
  const directByClause = new Map<number | null, DirectImpactDTO>();
  for (const occ of occurrences) {
    if (occ.kind !== 'reference' || !deleted.has(occ.number)) continue;
    const container = containerOf(blocks, occ.start);
    if (container && deleted.has(container.number)) continue; // 随区块一起删除，无需处理
    const key = container ? container.number : null;
    if (!directByClause.has(key)) {
      directByClause.set(key, {
        number: key,
        heading: container ? container.heading : '（首个条款之前的前言）',
        headingLine: container ? container.startLine : null,
        references: [],
      });
    }
    directByClause.get(key)!.references.push({
      number: occ.number,
      pos: occ.pos,
      line: lineTextAt(text, lineStarts, occ.start),
    });
  }
  const direct = [...directByClause.values()].sort(
    (a, b) => (a.headingLine ?? 0) - (b.headingLine ?? 0),
  );

  // 传递影响：沿引用链反向可达待删条款的存活条款（扣除直接影响）。
  // 边 甲 -> 乙 表示“甲的正文引用了乙”；乙被裁撤/被改动则甲受影响。
  const adjacency = new Map<number, number[]>();
  for (const b of blocks) {
    if (deleted.has(b.number)) continue;
    const list = adjacency.get(b.number) ?? [];
    list.push(...b.references);
    adjacency.set(b.number, list);
  }
  const impacted = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [from, tos] of adjacency) {
      if (impacted.has(from)) continue;
      if (tos.some((t) => deleted.has(t) || impacted.has(t))) {
        impacted.add(from);
        changed = true;
      }
    }
  }

  const directNumbers = new Set(direct.map((d) => d.number));
  const firstBlock = new Map<number, ClauseBlock>();
  for (const b of blocks) if (!firstBlock.has(b.number)) firstBlock.set(b.number, b);
  const transitive: TransitiveImpactDTO[] = [...impacted]
    .filter((n) => !directNumbers.has(n))
    .sort((a, b) => a - b)
    .map((n) => {
      const b = firstBlock.get(n)!;
      return { number: n, heading: b.heading, headingLine: b.startLine };
    });

  return { direct, transitive };
}

/** 宽松分析：只要求删除集合本身合法，用于展示影响与待办替代映射。 */
export function analyzeRemoval(
  text: string,
  numbers: number[],
): { ok: boolean; conflicts?: RemovalConflict[]; analysis?: RemovalAnalysisDTO } {
  const structural = validateSelection(text, numbers);
  if (structural.length > 0) return { ok: false, conflicts: structural };

  const { occurrences } = analyzeText(text);
  const blocks = buildClauseBlocks(text, occurrences);
  const deleted = new Set(numbers);
  const ctx: ImpactContext = { text, blocks, occurrences, deleted };
  const lineStarts = buildLineStarts(text);

  const removed = removedBlocksDTO(text, blocks, deleted);
  const impact = buildImpact(ctx);

  const required = new Map<number, RequiredReplacementDTO>();
  for (const occ of occurrences) {
    if (occ.kind !== 'reference' || !deleted.has(occ.number)) continue;
    const container = containerOf(blocks, occ.start);
    if (container && deleted.has(container.number)) continue;
    if (!required.has(occ.number)) {
      required.set(occ.number, { number: occ.number, references: [] });
    }
    required.get(occ.number)!.references.push({
      pos: occ.pos,
      line: lineTextAt(text, lineStarts, occ.start),
      clause: container ? container.number : null,
    });
  }

  return {
    ok: true,
    analysis: {
      removed,
      impact,
      requiredReplacements: [...required.values()].sort((a, b) => a.number - b.number),
      graph: buildReferenceGraph(blocks),
    },
  };
}

// ---------- 校验 ----------

/** 删除集合本身的结构校验：必须已定义且标题唯一（否则区块边界无法确定）。 */
function validateSelection(text: string, numbers: number[]): RemovalConflict[] {
  const { occurrences } = analyzeText(text);
  const defPositions = new Map<number, TextPos[]>();
  for (const o of occurrences) {
    if (o.kind !== 'definition') continue;
    const list = defPositions.get(o.number) ?? [];
    list.push(o.pos);
    defPositions.set(o.number, list);
  }

  const conflicts: RemovalConflict[] = [];
  for (const n of numbers) {
    const positions = defPositions.get(n);
    if (!positions) {
      conflicts.push({
        code: 'NOT_DEFINED',
        message: `第${n}条 在文本中没有标题定义，无法裁撤。`,
        number: n,
      });
    } else if (positions.length > 1) {
      conflicts.push({
        code: 'DUPLICATE_DEFINITION',
        message: `第${n}条 存在 ${positions.length} 处重复标题定义，区块边界无法确定，请先消除重复编号。`,
        number: n,
        positions,
      });
    }
  }
  return conflicts;
}

function removedBlocksDTO(
  text: string,
  blocks: ClauseBlock[],
  deleted: Set<number>,
): RemovedBlockDTO[] {
  return blocks
    .filter((b) => deleted.has(b.number))
    .map((b) => ({
      number: b.number,
      heading: b.heading,
      startLine: b.startLine,
      endLine: b.endLine,
      text: text.slice(b.startOffset, b.endOffset).replace(/\n$/, ''),
    }));
}

/**
 * 生成完整裁撤计划（不修改任何存储）。
 * 校验失败时返回冲突列表；成功时返回删除区块、逐处引用改写与重建后的新文本。
 */
export function buildRemovalPlan(
  text: string,
  numbers: number[],
  replacements: MappingEntry[],
): RemovalPlanResult {
  const conflicts: RemovalConflict[] = [];

  // 规则 1：待删编号必须已定义且标题唯一。
  conflicts.push(...validateSelection(text, numbers));
  if (conflicts.length > 0) return { ok: false, conflicts };

  const { occurrences } = analyzeText(text);
  const blocks = buildClauseBlocks(text, occurrences);
  const deleted = new Set(numbers);
  const repMap = new Map(replacements.map((r) => [r.from, r.to]));

  const defPositions = new Map<number, TextPos[]>();
  for (const o of occurrences) {
    if (o.kind !== 'definition') continue;
    const list = defPositions.get(o.number) ?? [];
    list.push(o.pos);
    defPositions.set(o.number, list);
  }

  // 规则 2：替代映射的源必须在删除集合内。
  for (const { from } of replacements) {
    if (!deleted.has(from)) {
      conflicts.push({
        code: 'REPLACEMENT_SOURCE_NOT_REMOVED',
        message: `替代映射的源 第${from}条 不在本次裁撤集合中。`,
        number: from,
      });
    }
  }

  // 规则 3：替代目标必须唯一已定义，且不得也在删除集合内。
  for (const { from, to } of replacements) {
    if (deleted.has(to)) {
      conflicts.push({
        code: 'TARGET_IN_REMOVAL_SET',
        message: `第${from}条 的替代目标 第${to}条 也在本次裁撤集合中，引用将悬空。`,
        number: to,
        positions: defPositions.get(to),
      });
      continue;
    }
    const positions = defPositions.get(to);
    if (!positions) {
      conflicts.push({
        code: 'TARGET_NOT_DEFINED',
        message: `第${from}条 的替代目标 第${to}条 在文本中没有标题定义。`,
        number: to,
      });
    } else if (positions.length > 1) {
      conflicts.push({
        code: 'DUPLICATE_DEFINITION',
        message: `替代目标 第${to}条 存在 ${positions.length} 处重复标题定义，无法确定唯一条款。`,
        number: to,
        positions,
      });
    }
  }

  // 规则 4：存活文本中每个指向待删条款的引用都必须有替代目标。
  const lineStarts = buildLineStarts(text);
  const unresolved = new Map<number, TextPos[]>();
  const rewrites: { occ: ClauseOccurrence; to: number }[] = [];
  for (const occ of occurrences) {
    if (occ.kind !== 'reference' || !deleted.has(occ.number)) continue;
    const container = containerOf(blocks, occ.start);
    if (container && deleted.has(container.number)) continue; // 随区块删除
    const to = repMap.get(occ.number);
    if (to === undefined || deleted.has(to)) {
      const list = unresolved.get(occ.number) ?? [];
      list.push(occ.pos);
      unresolved.set(occ.number, list);
    } else {
      rewrites.push({ occ, to });
    }
  }
  for (const [number, positions] of [...unresolved].sort((a, b) => a[0] - b[0])) {
    conflicts.push({
      code: 'UNRESOLVED_REFERENCE',
      message: `第${number}条 仍被存活文本引用 ${positions.length} 处，但未指定替代目标。`,
      number,
      positions,
    });
  }

  if (conflicts.length > 0) return { ok: false, conflicts };

  // 单遍重建：删除区块切除 + 存活引用改写，互不重迭，写入独立缓冲。
  const edits: { start: number; end: number; text: string }[] = [];
  for (const b of blocks) {
    if (deleted.has(b.number)) edits.push({ start: b.startOffset, end: b.endOffset, text: '' });
  }
  const changes: ChangeItem[] = [];
  for (const { occ, to } of rewrites) {
    const newToken = `第${renderClauseNumber(to, occ.style)}条`;
    edits.push({ start: occ.start, end: occ.end, text: newToken });
    changes.push({
      kind: 'reference',
      fromNumber: occ.number,
      toNumber: to,
      before: occ.text,
      after: newToken,
      line: occ.pos.line,
      column: occ.pos.column,
      snippet: snippetAround(text, occ.start, occ.end),
    });
  }
  edits.sort((a, b) => a.start - b.start);

  const parts: string[] = [];
  let cursor = 0;
  for (const e of edits) {
    parts.push(text.slice(cursor, e.start), e.text);
    cursor = e.end;
  }
  parts.push(text.slice(cursor));

  changes.sort((a, b) => a.line - b.line || a.column - b.column);

  return {
    ok: true,
    removed: removedBlocksDTO(text, blocks, deleted),
    impact: buildImpact({ text, blocks, occurrences, deleted }),
    replacements: [...repMap].map(([from, to]) => ({ from, to })),
    changes,
    newText: parts.join(''),
  };
}
