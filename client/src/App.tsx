import { useState } from 'react';
import { api } from './api';
import type {
  AnalyzeDTO,
  CommitResult,
  ConflictError,
  DocumentDTO,
  MappingEntry,
  PreviewResult,
  UndoResult,
} from './types';
import { SAMPLE_CONTRACT } from './sample';
import AnalysisPanel from './components/AnalysisPanel';
import MappingEditor, { type MappingRow } from './components/MappingEditor';
import PreviewPanel from './components/PreviewPanel';
import Conflicts from './components/Conflicts';
import HighlightedText from './components/HighlightedText';

interface ClientError {
  code: string;
  message: string;
  conflicts: ConflictError[];
}

let rowSeq = 1;
const emptyRows = (): MappingRow[] => [{ id: rowSeq++, from: '', to: '' }];

export default function App() {
  const [draft, setDraft] = useState('');
  const [doc, setDoc] = useState<DocumentDTO | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeDTO | null>(null);
  const [rows, setRows] = useState<MappingRow[]>(emptyRows());
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [committed, setCommitted] = useState<CommitResult | null>(null);
  const [lastUndo, setLastUndo] = useState<UndoResult | null>(null);
  const [conflicts, setConflicts] = useState<ConflictError[]>([]);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);

  const toMapping = (): MappingEntry[] =>
    rows
      .map((r) => ({ from: Number(r.from), to: Number(r.to) }))
      .filter((m) => Number.isInteger(m.from) && Number.isInteger(m.to));

  const resetWorkspace = (d: DocumentDTO, a: AnalyzeDTO) => {
    setDoc(d);
    setAnalysis(a);
    setRows(emptyRows());
    setPreview(null);
    setCommitted(null);
    setLastUndo(null);
    setConflicts([]);
    setEditing(false);
  };

  const parse = async () => {
    if (!draft.trim()) {
      setNotice('请先粘贴合同文本。');
      return;
    }
    setLoading(true);
    setConflicts([]);
    setNotice('');
    try {
      const { document, analysis } = await api.createDocument('未命名合同', draft);
      resetWorkspace(document, analysis);
      setNotice('解析完成，已建立工作台文档。');
    } catch (e) {
      const err = e as ClientError;
      setConflicts(err.conflicts.length ? err.conflicts : []);
      setNotice(err.message);
    } finally {
      setLoading(false);
    }
  };

  const changeRows = (next: MappingRow[]) => {
    setRows(next);
    // 映射一旦改动，旧预览即失效
    setPreview(null);
    setCommitted(null);
    setConflicts([]);
  };

  const doPreview = async () => {
    if (!doc) return;
    setLoading(true);
    setConflicts([]);
    setNotice('');
    try {
      const result = await api.preview(doc.id, toMapping());
      setPreview(result);
      setCommitted(null);
    } catch (e) {
      const err = e as ClientError;
      setPreview(null);
      setConflicts(
        err.conflicts.length
          ? err.conflicts
          : [{ code: err.code, message: err.message }],
      );
    } finally {
      setLoading(false);
    }
  };

  const doCommit = async () => {
    if (!doc) return;
    setLoading(true);
    setConflicts([]);
    setNotice('');
    try {
      const result = await api.commit(doc.id, toMapping());
      setDoc(result.document);
      setAnalysis(result.analysis);
      setCommitted(result);
      setPreview(null);
      setRows(emptyRows());
      setLastUndo(null);
      setNotice(`已原子提交：共更新 ${result.changeCount} 处“第X条”。可撤销本次操作。`);
    } catch (e) {
      const err = e as ClientError;
      setConflicts(
        err.conflicts.length
          ? err.conflicts
          : [{ code: err.code, message: err.message }],
      );
    } finally {
      setLoading(false);
    }
  };

  const doUndo = async () => {
    if (!doc) return;
    setLoading(true);
    setConflicts([]);
    setNotice('');
    try {
      const result = await api.undo(doc.id);
      setDoc(result.document);
      setAnalysis(result.analysis);
      setLastUndo(result);
      setCommitted(null);
      setPreview(null);
      setRows(emptyRows());
      setNotice(
        `已撤销最近一次改号（${result.undone.changeCount} 处，恢复到操作前文本）。`,
      );
    } catch (e) {
      const err = e as ClientError;
      setNotice(err.message);
    } finally {
      setLoading(false);
    }
  };

  const saveEdit = async () => {
    if (!doc) return;
    setLoading(true);
    try {
      const { document, analysis } = await api.updateDocument(doc.id, doc.title, draft);
      resetWorkspace(document, analysis);
      setNotice('原文已更新（此前撤销记录已清空）。');
    } catch (e) {
      setNotice((e as ClientError).message);
    } finally {
      setLoading(false);
    }
  };

  const changedTargets = committed
    ? new Set(committed.changes.map((c) => c.toNumber))
    : null;

  return (
    <div className="app">
      <header>
        <h1>合同条款重编号工作台</h1>
        <p className="subtitle">
          解析“第X条”定义与引用 · 批量映射 · 逐处预览 · 原子同步标题与正文 · 可撤销 · 可导出
        </p>
      </header>

      {notice && <div className="notice">{notice}</div>}
      <Conflicts conflicts={conflicts} />

      {/* 步骤一：粘贴文本 */}
      <section className="card">
        <h3>
          1. 粘贴合同纯文本
          {doc && !editing && (
            <button
              type="button"
              className="btn btn-link"
              onClick={() => {
                setDraft(doc.content);
                setEditing(true);
              }}
            >
              编辑原文
            </button>
          )}
        </h3>
        {!doc || editing ? (
          <>
            <textarea
              className="contract-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={'在此粘贴合同文本……\n系统将识别行首的“第X条”为条款定义，其余出现为引用。'}
              rows={14}
            />
            <div className="row-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setDraft(SAMPLE_CONTRACT)}
              >
                载入示例（含重复编号 / 缺失引用 / 第1条与第10条）
              </button>
              <div className="spacer" />
              {editing && (
                <button type="button" className="btn" onClick={() => setEditing(false)}>
                  取消
                </button>
              )}
              <button type="button" className="btn btn-primary" onClick={parse} disabled={loading}>
                {loading ? '解析中…' : '解析并建立工作台'}
              </button>
              {editing && (
                <button type="button" className="btn" onClick={saveEdit} disabled={loading}>
                  保存原文
                </button>
              )}
            </div>
          </>
        ) : (
          <details>
            <summary>查看当前原文</summary>
            <pre className="contract-view">{doc.content}</pre>
          </details>
        )}
      </section>

      {analysis && !editing && (
        <>
          <div className="step">2. 检查引用关系</div>
          <AnalysisPanel analysis={analysis} />

          <div className="step">3. 填写改号映射</div>
          <MappingEditor
            analysis={analysis}
            rows={rows}
            onChange={changeRows}
            onPreview={doPreview}
            onCommit={doCommit}
            loading={loading}
            hasPreview={!!preview}
          />

          {preview && <PreviewPanel preview={preview} />}

          {committed && (
            <section className="card">
              <h3>✅ 已提交结果</h3>
              <p className="muted">
                本次更新 {committed.changeCount} 处，映射：
                {committed.mapping.map((m) => `${m.from}→${m.to}`).join('、')}
              </p>
              <details open>
                <summary>处理后的全文（高亮本次变更）</summary>
                {changedTargets && (
                  <HighlightedText text={committed.document.content} targets={changedTargets} />
                )}
              </details>
            </section>
          )}

          <div className="step">4. 撤销 / 导出</div>
          <section className="card final-bar">
            <button type="button" className="btn" onClick={doUndo} disabled={loading}>
              ↩ 撤销最近一次改号
            </button>
            <a className="btn btn-primary" href={doc ? api.exportUrl(doc.id) : '#'}>
              ⬇ 导出处理后的文本（.txt）
            </a>
            {lastUndo && (
              <span className="muted small">
                上次撤销：{lastUndo.undone.changeCount} 处，映射{' '}
                {lastUndo.undone.mapping.map((m) => `${m.from}→${m.to}`).join('、')}
              </span>
            )}
          </section>
        </>
      )}

      <footer className="muted small">
        编号支持阿拉伯数字与中文数字（第一条 ↔ 第1条风格各自保留）；冲突拒绝写入并给出
        行/列位置。
      </footer>
    </div>
  );
}
