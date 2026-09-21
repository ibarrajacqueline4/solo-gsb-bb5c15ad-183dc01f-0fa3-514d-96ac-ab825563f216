import type {
  AnalyzeDTO,
  ApiError,
  CommitResult,
  DocumentDTO,
  MappingEntry,
  PreviewResult,
  RemovalAnalysis,
  RemovalCommitResult,
  RemovalPreview,
  UndoResult,
} from './types';

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const apiError = (data as ApiError | null)?.error;
    throw {
      code: apiError?.code ?? 'HTTP_ERROR',
      message: apiError?.message ?? `请求失败（${res.status}）`,
      conflicts: apiError?.conflicts ?? [],
    };
  }
  return data as T;
}

export interface AnalysisResponse {
  analysis: AnalyzeDTO;
}

export const api = {
  analyze(content: string) {
    return request<AnalysisResponse>('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
  },
  createDocument(title: string, content: string) {
    return request<{ document: DocumentDTO; analysis: AnalyzeDTO }>('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ title, content }),
    });
  },
  getDocument(id: number) {
    return request<{ document: DocumentDTO; analysis: AnalyzeDTO }>(
      `/api/documents/${id}`,
    );
  },
  updateDocument(id: number, title: string, content: string) {
    return request<{ document: DocumentDTO; analysis: AnalyzeDTO }>(
      `/api/documents/${id}`,
      { method: 'PUT', body: JSON.stringify({ title, content }) },
    );
  },
  preview(id: number, mapping: { from: number; to: number }[]) {
    return request<PreviewResult>(`/api/documents/${id}/renumber/preview`, {
      method: 'POST',
      body: JSON.stringify({ mapping }),
    });
  },
  commit(id: number, mapping: { from: number; to: number }[]) {
    return request<CommitResult>(`/api/documents/${id}/renumber/commit`, {
      method: 'POST',
      body: JSON.stringify({ mapping }),
    });
  },
  undo(id: number) {
    return request<UndoResult>(`/api/documents/${id}/undo`, { method: 'POST' });
  },
  removalAnalyze(id: number, numbers: number[]) {
    return request<RemovalAnalysis>(`/api/documents/${id}/removal/analyze`, {
      method: 'POST',
      body: JSON.stringify({ numbers }),
    });
  },
  removalPreview(id: number, numbers: number[], replacements: MappingEntry[]) {
    return request<RemovalPreview>(`/api/documents/${id}/removal/preview`, {
      method: 'POST',
      body: JSON.stringify({ numbers, replacements }),
    });
  },
  removalCommit(id: number, numbers: number[], replacements: MappingEntry[]) {
    return request<RemovalCommitResult>(`/api/documents/${id}/removal/commit`, {
      method: 'POST',
      body: JSON.stringify({ numbers, replacements }),
    });
  },
  exportUrl(id: number) {
    return `/api/documents/${id}/export`;
  },
};
