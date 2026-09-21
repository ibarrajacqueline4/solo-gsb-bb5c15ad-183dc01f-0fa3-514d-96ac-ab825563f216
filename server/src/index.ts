import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  initDB,
  createDocument,
  getDocument,
  updateDocument,
  listDocuments,
  commitRenumber,
  undoLastRenumber,
} from './db';
import { analyzeText, toAnalyzeDTO } from './parser';
import { buildPlan, normalizeMapping, type ConflictError, type RawRow } from './renumber';
import {
  analyzeRemoval,
  buildRemovalPlan,
  normalizeRemovalRequest,
  type RemovalConflict,
} from './removal';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
// 默认放在 server/data 下；容器通过 ENV DB_PATH=/data/contract.db 覆盖到持久化卷。
const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, '..', 'data', 'contract.db');

initDB(DB_PATH);

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ---------- helpers ----------

function fail(res: express.Response, status: number, code: string, message: string, extra?: object) {
  res.status(status).json({ error: { code, message, ...extra } });
}

function analysisOf(content: string) {
  return toAnalyzeDTO(content, analyzeText(content));
}

/** 校验并规范化映射，冲突时以 409 返回（不做任何写入）。 */
function planOrConflict(res: express.Response, content: string, rawMapping: unknown) {
  const { entries, errors } = normalizeMapping((rawMapping as RawRow[]) ?? []);
  if (errors.length > 0) {
    fail(res, 409, 'MAPPING_REJECTED', '映射未通过校验，已拒绝写入。', { conflicts: errors });
    return null;
  }
  const plan = buildPlan(content, entries);
  if (!plan.ok) {
    const conflicts: ConflictError[] = plan.conflicts ?? [];
    fail(res, 409, 'RENUMBER_CONFLICT', '存在编号冲突，已拒绝写入。', { conflicts });
    return null;
  }
  return { entries, plan };
}

const requireDoc = (res: express.Response, id: number) => {
  const doc = getDocument(id);
  if (!doc) {
    fail(res, 404, 'NOT_FOUND', `文档 ${id} 不存在。`);
    return null;
  }
  return doc;
};

/** 校验裁撤请求并生成计划，冲突时以 409 返回（不做任何写入）。 */
function removalPlanOrConflict(res: express.Response, content: string, body: unknown) {
  const { numbers, replacements, errors } = normalizeRemovalRequest(body);
  if (errors.length > 0) {
    fail(res, 409, 'REMOVAL_REJECTED', '裁撤请求未通过校验，已拒绝写入。', {
      conflicts: errors,
    });
    return null;
  }
  const plan = buildRemovalPlan(content, numbers, replacements);
  if (!plan.ok) {
    const conflicts: RemovalConflict[] = plan.conflicts ?? [];
    fail(res, 409, 'REMOVAL_CONFLICT', '存在未处理的引用或编号冲突，已拒绝写入。', {
      conflicts,
    });
    return null;
  }
  return { numbers, replacements, plan };
}

// ---------- API ----------

// 无状态解析：不写库，粘贴即可检查缺失引用 / 重复编号。
app.post('/api/analyze', (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content : null;
  if (content === null) return fail(res, 400, 'BAD_REQUEST', '缺少 content（纯文本）。');
  res.json({ analysis: analysisOf(content) });
});

app.get('/api/documents', (_req, res) => {
  res.json({ documents: listDocuments() });
});

app.post('/api/documents', (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content : null;
  const title = typeof req.body?.title === 'string' && req.body.title.trim()
    ? req.body.title.trim()
    : '未命名合同';
  if (content === null) return fail(res, 400, 'BAD_REQUEST', '缺少 content（纯文本）。');
  const doc = createDocument(title, content);
  res.status(201).json({ document: doc, analysis: analysisOf(doc.content) });
});

app.get('/api/documents/:id', (req, res) => {
  const doc = requireDoc(res, Number(req.params.id));
  if (!doc) return;
  res.json({ document: doc, analysis: analysisOf(doc.content) });
});

// 手工修改原文：内容更新，撤销栈清空（历史已不连续）。
app.put('/api/documents/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = requireDoc(res, id);
  if (!existing) return;
  const content = typeof req.body?.content === 'string' ? req.body.content : existing.content;
  const title =
    typeof req.body?.title === 'string' && req.body.title.trim()
      ? req.body.title.trim()
      : existing.title;
  const doc = updateDocument(id, title, content)!;
  res.json({ document: doc, analysis: analysisOf(doc.content) });
});

// 逐处变更预览（只读）。
app.post('/api/documents/:id/renumber/preview', (req, res) => {
  const id = Number(req.params.id);
  const doc = requireDoc(res, id);
  if (!doc) return;
  const planned = planOrConflict(res, doc.content, req.body?.mapping);
  if (!planned) return;
  res.json({
    mapping: planned.entries,
    changeCount: planned.plan.changes!.length,
    changes: planned.plan.changes,
    previewText: planned.plan.newText,
  });
});

// 确认提交：历史与正文在同一 SQLite 事务中原子落库。
app.post('/api/documents/:id/renumber/commit', (req, res) => {
  const id = Number(req.params.id);
  const doc = requireDoc(res, id);
  if (!doc) return;
  const planned = planOrConflict(res, doc.content, req.body?.mapping);
  if (!planned) return;
  const { entries, plan } = planned;

  commitRenumber(
    id,
    doc.content,
    plan.newText!,
    JSON.stringify(entries),
    plan.changes!.length,
  );

  const updated = getDocument(id)!;
  res.json({
    document: updated,
    mapping: entries,
    changeCount: plan.changes!.length,
    changes: plan.changes,
    analysis: analysisOf(updated.content),
  });
});

// ---------- 条款裁撤 ----------

// 影响分析（宽松）：删除区块、引用图、直接与传递影响、待办替代映射。
app.post('/api/documents/:id/removal/analyze', (req, res) => {
  const id = Number(req.params.id);
  const doc = requireDoc(res, id);
  if (!doc) return;
  const { numbers, errors } = normalizeRemovalRequest(req.body);
  if (errors.length > 0) {
    return fail(res, 409, 'REMOVAL_REJECTED', '裁撤请求未通过校验。', { conflicts: errors });
  }
  const result = analyzeRemoval(doc.content, numbers);
  if (!result.ok) {
    return fail(res, 409, 'REMOVAL_CONFLICT', '待删条款存在重复或缺失定义。', {
      conflicts: result.conflicts ?? [],
    });
  }
  res.json({ numbers, ...result.analysis });
});

// 裁撤预览（严格）：删除区块 + 逐处引用改写 + 处理后全文；冲突返回 409。
app.post('/api/documents/:id/removal/preview', (req, res) => {
  const id = Number(req.params.id);
  const doc = requireDoc(res, id);
  if (!doc) return;
  const planned = removalPlanOrConflict(res, doc.content, req.body);
  if (!planned) return;
  const { plan } = planned;
  res.json({
    removed: plan.removed,
    impact: plan.impact,
    replacements: plan.replacements,
    changeCount: plan.removed!.length + plan.changes!.length,
    changes: plan.changes,
    previewText: plan.newText,
  });
});

// 确认裁撤：历史与正文在同一 SQLite 事务中原子落库，撤销入口与改号共用。
app.post('/api/documents/:id/removal/commit', (req, res) => {
  const id = Number(req.params.id);
  const doc = requireDoc(res, id);
  if (!doc) return;
  const planned = removalPlanOrConflict(res, doc.content, req.body);
  if (!planned) return;
  const { numbers, replacements, plan } = planned;

  const changeCount = plan.removed!.length + plan.changes!.length;
  commitRenumber(
    id,
    doc.content,
    plan.newText!,
    JSON.stringify({ kind: 'removal', removed: numbers, replacements }),
    changeCount,
  );

  const updated = getDocument(id)!;
  res.json({
    document: updated,
    removed: plan.removed,
    replacements: plan.replacements,
    changeCount,
    changes: plan.changes,
    analysis: analysisOf(updated.content),
  });
});

// 撤销最近一次改号或裁撤（栈式，可连续撤销）。
app.post('/api/documents/:id/undo', (req, res) => {
  const id = Number(req.params.id);
  const doc = requireDoc(res, id);
  if (!doc) return;
  const undone = undoLastRenumber(id);
  if (!undone) {
    return fail(res, 409, 'NOTHING_TO_UNDO', '没有可撤销的操作记录。');
  }
  // 历史中的 mapping 字段：数组为改号映射；{ kind: 'removal', ... } 为裁撤记录。
  const parsed = JSON.parse(undone.mapping);
  const isRemoval =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) &&
    parsed.kind === 'removal';
  const updated = getDocument(id)!;
  res.json({
    document: updated,
    undone: {
      kind: isRemoval ? 'removal' : 'renumber',
      mapping: isRemoval ? parsed.replacements : parsed,
      removed: isRemoval ? parsed.removed : undefined,
      changeCount: undone.change_count,
      createdAt: undone.created_at,
    },
    analysis: analysisOf(updated.content),
  });
});

// 导出处理后的纯文本。
app.get('/api/documents/:id/export', (req, res) => {
  const id = Number(req.params.id);
  const doc = requireDoc(res, id);
  if (!doc) return;
  const filename = encodeURIComponent(`${doc.title || 'contract'}.txt`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  res.send(doc.content);
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---------- 生产环境静态资源 ----------

const clientDist = path.join(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  fail(res, 500, 'INTERNAL', err.message || '服务器内部错误');
});

app.listen(PORT, HOST, () => {
  console.log(`合同条款重编号工作台已启动: http://localhost:${PORT}`);
  console.log(`SQLite: ${DB_PATH}`);
});
