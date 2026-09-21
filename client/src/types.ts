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

// ---------- 条款裁撤 ----------

export interface RemovedBlock {
  number: number;
  heading: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface ImpactReference {
  number: number;
  pos: TextPos;
  line: string;
}

export interface DirectImpact {
  /** null 表示首个条款之前的前言区域 */
  number: number | null;
  heading: string;
  headingLine: number | null;
  references: ImpactReference[];
}

export interface TransitiveImpact {
  number: number;
  heading: string;
  headingLine: number;
}

export interface RemovalImpact {
  direct: DirectImpact[];
  transitive: TransitiveImpact[];
}

export interface ReferenceEdge {
  from: number;
  to: number;
}

export interface RequiredReplacement {
  number: number;
  references: { pos: TextPos; line: string; clause: number | null }[];
}

export interface RemovalAnalysis {
  numbers: number[];
  removed: RemovedBlock[];
  impact: RemovalImpact;
  requiredReplacements: RequiredReplacement[];
  graph: ReferenceEdge[];
}

export interface RemovalPreview {
  removed: RemovedBlock[];
  impact: RemovalImpact;
  replacements: MappingEntry[];
  changeCount: number;
  changes: ChangeItem[];
  previewText: string;
}

export interface RemovalCommitResult {
  document: DocumentDTO;
  removed: RemovedBlock[];
  replacements: MappingEntry[];
  changeCount: number;
  changes: ChangeItem[];
  analysis: AnalyzeDTO;
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
  undone: {
    kind: 'renumber' | 'removal';
    mapping: MappingEntry[];
    removed?: number[];
    changeCount: number;
    createdAt: string;
  };
  analysis: AnalyzeDTO;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    conflicts?: ConflictError[];
  };
}
