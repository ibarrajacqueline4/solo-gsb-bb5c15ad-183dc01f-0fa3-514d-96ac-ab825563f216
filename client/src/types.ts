// 与后端 DTO 保持一致的前端类型。

export interface TextPos {
  line: number;
  column: number;
  offset: number;
}

export type IssueKind = 'duplicate_definition' | 'missing_reference';

export interface Issue {
  kind: IssueKind;
  number: number;
  message: string;
  start: number;
  end: number;
  pos: TextPos;
}

export interface DefinitionDTO {
  number: number;
  heading: string;
  headingLine: number;
  pos: TextPos;
  occurrenceCount: number;
}

export interface ReferenceDTO {
  number: number;
  pos: TextPos;
  line: string;
  targetDefined: boolean;
}

export interface AnalyzeDTO {
  totalOccurrences: number;
  definedNumbers: number[];
  definitions: DefinitionDTO[];
  references: ReferenceDTO[];
  issues: Issue[];
}

export interface DocumentDTO {
  id: number;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface MappingEntry {
  from: number;
  to: number;
}

export interface ConflictError {
  code: string;
  message: string;
  from?: number;
  to?: number;
  positions?: TextPos[];
}

export interface ChangeItem {
  kind: 'definition' | 'reference';
  fromNumber: number;
  toNumber: number;
  before: string;
  after: string;
  line: number;
  column: number;
  snippet: string;
}

export interface PreviewResult {
  mapping: MappingEntry[];
  changeCount: number;
  changes: ChangeItem[];
  previewText: string;
}

export interface CommitResult {
  document: DocumentDTO;
  mapping: MappingEntry[];
  changeCount: number;
  changes: ChangeItem[];
  analysis: AnalyzeDTO;
}

export interface UndoResult {
  document: DocumentDTO;
  undone: { mapping: MappingEntry[]; changeCount: number; createdAt: string };
  analysis: AnalyzeDTO;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    conflicts?: ConflictError[];
  };
}
