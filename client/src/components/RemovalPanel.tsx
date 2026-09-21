import { useMemo, useState } from 'react';
import { api } from '../api';
import type {
  AnalyzeDTO,
  ConflictError,
  MappingEntry,
  RemovalAnalysis,
  RemovalCommitResult,
  RemovalPreview,
} from '../types';
import HighlightedText from './HighlightedText';

interface ClientError {
  code: string;
  message: string;
  conflicts: ConflictError[];
}

/**
 * 条款裁撤流程：勾选条款 -> 影响分析（引用图 / 直接与传递影响）->
 * 为每个仍被引用的待删条款指定替代目标 -> 预览 -> 原子提交。
 */
export default function RemovalPanel({
  docId,
  analysis,
  loading,
  setLoading,
  onConflicts,
  onNotice,
  onCommitted,
}: {
  docId: number;
  analysis: AnalyzeDTO;
  loading: boolean;
  setLoading: (v: boolean) => void;
  onConflicts: (conflicts: ConflictError[]) => void;
  onNotice: (message: string) => void;
  onCommitted: (result: RemovalCommitResult) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [impact, setImpact] = useState<RemovalAnalysis | null>(null);
  const [targets, setTargets] = useState<Record<number, string>>({});
  const [preview, setPreview] = useState<RemovalPreview | null>(null);

  const defined = analysis.definedNumbers;
  const headingOf = useMemo(() => {
    const map = new Map<number, string>();
    for (const d of analysis.definitions) map.set(d.number, d.heading);
    return map;
  }, [analysis]);

  const reset = () => {
    setImpact(null);
    setPreview(null);
    setTargets({});
  };

  const toggle = (n: number) => {
    const next = new Set(selected);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    setSelected(next);
    reset();
    onConflicts([]);
  };

  const reportError = (e: unknown) => {
    const err = e as ClientError;
    onConflicts(
      err.conflicts?.length ? err.conflicts : [{ code: err.code, message: err.message }],
    );
  };

  const selectedList = [...selected].sort((a, b) => a - b);

  const doAnalyze = async () => {
    setLoading(true);
    onConflicts([]);
    try {
      const result = await api.removalAnalyze(docId, selectedList);
      setImpact(result);
      setPreview(null);
      // 为每个待办替代准备输入行（默认空，必须逐一指定）
      const init: Record<number, string> = {};
      for (const r of result.requiredReplacements) init[r.number] = '';
      setTargets(init);
      onNotice(
        result.requiredReplacements.length > 0
          ? `影响分析完成：${result.requiredReplacements.length} 个待删条款仍被引用，需指定替代目标。`
          : '影响分析完成：所选条款无存活引用，可直接裁撤。',
      );
    } catch (e) {
      reset();
      reportError(e);
    } finally {
      setLoading(false);
    }
  };

  const toReplacements = (): MappingEntry[] =>
    Object.entries(targets)
      .filter(([, to]) => to.trim() !== '')
      .map(([from, to]) => ({ from: Number(from), to: Number(to) }));

  const doPreview = async () => {
    setLoading(true);
    onConflicts([]);
    try {
      const result = await api.removalPreview(docId, selectedList, toReplacements());
      setPreview(result);
    } catch (e) {
      setPreview(null);
      reportError(e);
    } finally {
      setLoading(false);
    }
  };

  const doCommit = async () => {
    setLoading(true);
    onConflicts([]);
    try {
      const result = await api.removalCommit(docId, selectedList, toReplacements());
      onCommitted(result);
    } catch (e) {
      reportError(e);
    } finally {
      setLoading(false);
    }
  };

  // 可选的替代目标：已定义且不在删除集合内
  const targetOptions = defined.filter((n) => !selected.has(n));
  const requiredNumbers = new Set(impact?.requiredReplacements.map((r) => r.number) ?? []);
  const allRequiredFilled =
    impact !== null && impact.requiredReplacements.every((r) => targets[r.number]?.trim());

  return (
    <section className="card">
      <h3>条款裁撤</h3>
      <p className="muted small">
        勾选要裁撤的条款：系统按标题边界切除其正文区块，并基于引用图列出直接引用位置与沿引用链传递受影响的条款。
        仍被存活文本引用的待删条款必须逐一指定替代目标；无引用的条款可直接裁撤。
      </p>

      {/* 1. 选择条款 */}
      <div className="clause-check-list">
        {analysis.definitions.map((d) => (
          <label key={d.number} className={selected.has(d.number) ? 'clause-check on' : 'clause-check'}>
            <input
              type="checkbox"
              checked={selected.has(d.number)}
              onChange={() => toggle(d.number)}
            />
            <span className="num">第{d.number}条</span>
            <span className="ellipsis muted">{d.heading}</span>
          </label>
        ))}
      </div>

      <div className="row-actions">
        <span className="muted small">已选 {selected.size} 条</span>
        <div className="spacer" />
        <button
          type="button"
          className="btn"
          onClick={doAnalyze}
          disabled={loading || selected.size === 0}
        >
          {loading ? '分析中…' : '分析影响'}
        </button>
      </div>

      {/* 2. 影响分析结果 */}
      {impact && (
        <div className="removal-impact">
          <h4>删除区块（{impact.removed.length}）</h4>
          <table className="data-table">
            <thead>
              <tr>
                <th>编号</th>
                <th>标题</th>
                <th>行范围</th>
              </tr>
            </thead>
            <tbody>
              {impact.removed.map((b) => (
                <tr key={b.number} className="row-removed">
                  <td className="num">第{b.number}条</td>
                  <td className="ellipsis">{b.heading}</td>
                  <td>
                    第 {b.startLine} – {b.endLine} 行
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4>引用影响</h4>
          {impact.impact.direct.length === 0 && impact.impact.transitive.length === 0 && (
            <p className="muted small">无存活条款引用所选条款，可直接裁撤。</p>
          )}
          {impact.impact.direct.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>直接受影响的条款</th>
                  <th>引用位置</th>
                  <th>上下文</th>
                </tr>
              </thead>
              <tbody>
                {impact.impact.direct.map((d, i) => (
                  <tr key={i}>
                    <td className="num">
                      {d.number === null ? '（前言）' : `第${d.number}条`}
                    </td>
                    <td>
                      {d.references.map((r, j) => (
                        <span key={j} className="pos-chip">
                          第{r.pos.line}行第{r.pos.column}列 → 第{r.number}条
                        </span>
                      ))}
                    </td>
                    <td className="ellipsis">{d.references[0]?.line}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {impact.impact.transitive.length > 0 && (
            <p className="muted small">
              沿引用链传递受影响：
              {impact.impact.transitive.map((t) => `第${t.number}条（第${t.headingLine}行）`).join('、')}
            </p>
          )}

          {/* 3. 替代映射 */}
          {impact.requiredReplacements.length > 0 && (
            <>
              <h4>替代映射（每个仍被引用的待删条款必须指定一个未删除条款）</h4>
              <table className="data-table mapping-table">
                <thead>
                  <tr>
                    <th>待删条款</th>
                    <th>被引用次数</th>
                    <th></th>
                    <th>替代目标</th>
                  </tr>
                </thead>
                <tbody>
                  {impact.requiredReplacements.map((r) => {
                    const value = targets[r.number] ?? '';
                    const bad = value !== '' && !targetOptions.includes(Number(value));
                    return (
                      <tr key={r.number}>
                        <td className="num">第{r.number}条</td>
                        <td>{r.references.length} 处</td>
                        <td className="arrow">→</td>
                        <td>
                          <select
                            value={value}
                            className={bad || value === '' ? 'input-bad' : ''}
                            onChange={(e) => {
                              setTargets({ ...targets, [r.number]: e.target.value });
                              setPreview(null);
                              onConflicts([]);
                            }}
                          >
                            <option value="">请选择替代条款…</option>
                            {targetOptions.map((n) => (
                              <option key={n} value={n}>
                                第{n}条 {headingOf.get(n) ?? ''}
                              </option>
                            ))}
                          </select>
                          {bad && <div className="field-hint bad">目标无效或也在删除集合中</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}

          <div className="row-actions">
            <div className="spacer" />
            <button
              type="button"
              className="btn"
              onClick={doPreview}
              disabled={loading || !allRequiredFilled}
              title={allRequiredFilled ? '' : '请先为所有待删条款指定替代目标'}
            >
              {loading ? '计算中…' : '生成裁撤预览'}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={doCommit}
              disabled={loading || !preview}
              title={preview ? '' : '请先生成预览'}
            >
              确认裁撤（原子提交）
            </button>
          </div>
        </div>
      )}

      {/* 4. 预览 */}
      {preview && (
        <div className="removal-preview">
          <h4>裁撤预览（{preview.changeCount} 处变动）</h4>
          {preview.removed.map((b) => (
            <details key={b.number} className="removed-block">
              <summary>
                🗑 第{b.number}条（第 {b.startLine} – {b.endLine} 行）将被删除：{b.heading}
              </summary>
              <pre className="removed-text">{b.text}</pre>
            </details>
          ))}
          {preview.changes.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>位置</th>
                  <th>改动</th>
                  <th>上下文</th>
                </tr>
              </thead>
              <tbody>
                {preview.changes.map((c, i) => (
                  <tr key={i}>
                    <td>
                      <span className="kind kind-reference">引用</span>
                    </td>
                    <td>
                      {c.line}:{c.column}
                    </td>
                    <td className="num">
                      <del>{c.before}</del> <span className="arrow">→</span>{' '}
                      <strong className="after">{c.after}</strong>
                    </td>
                    <td className="ellipsis">{c.snippet}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <details>
            <summary>查看裁撤后的全文（高亮改写的引用）</summary>
            <HighlightedText
              text={preview.previewText}
              targets={new Set(preview.changes.map((c) => c.toNumber))}
            />
          </details>
        </div>
      )}
    </section>
  );
}
