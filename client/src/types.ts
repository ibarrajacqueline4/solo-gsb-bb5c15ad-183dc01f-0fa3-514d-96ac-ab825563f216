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
  undone: {
    op: 'renumber' | 'remove';
    mapping: MappingEntry[];
    deletes?: number[] | null;
    replacements?: RemovalReplacement[] | null;
    changeCount: number;
    createdAt: string;
  };
  analysis: AnalyzeDTO;
}

// ---------- 条款裁撤 ----------

export interface RemovalReplacement {
  from: number;
  to: number;
}

export interface DirectRefDTO {
  number: number;
  pos: TextPos;
  line: string;
  ownerNumber: number | null;
  ownerHeading: string | null;
  replacement?: number;
}

export interface ImpactedClauseDTO {
  number: number;
  heading: string;
  headingLine: number;
  direct: boolean;
  paths: number[][];
  directRefs: { number: number; pos: TextPos }[];
}

export interface DeletedClauseDTO {
  number: number;
  heading: string;
  headingLine: number;
  survivingRefCount: number;
  unreferenced: boolean;
}

export interface RemovalImpact {
  deletes: DeletedClauseDTO[];
  directReferences: DirectRefDTO[];
  impacted: ImpactedClauseDTO[];
  unreferenced: number[];
}

export interface NeighborHeadingDTO {
  number: number;
  heading: string;
  headingLine: number;
}

export interface RemovalBlock {
  number: number;
  heading: string;
  start: TextPos;
  end: TextPos;
  startLine: number;
  endLine: number;
  removedText: string;
  prev: NeighborHeadingDTO | null;
  next: NeighborHeadingDTO | null;
}

export interface RemovalChangeItem {
  kind: 'reference';
  fromNumber: number;
  toNumber: number;
  before: string;
  after: string;
  line: number;
  column: number;
  snippet: string;
  ownerNumber: number | null;
}

export interface RemovalPreviewResult {
  deletes: number[];
  replacements: RemovalReplacement[];
  deleteCount: number;
  blocks: RemovalBlock[];
  changes: RemovalChangeItem[];
  changeCount: number;
  impact: RemovalImpact;
  previewText: string;
}

export interface RemovalCommitResult {
  document: DocumentDTO;
  deletes: number[];
  replacements: RemovalReplacement[];
  deleteCount: number;
  blocks: RemovalBlock[];
  changes: RemovalChangeItem[];
  changeCount: number;
  analysis: AnalyzeDTO;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    conflicts?: ConflictError[];
  };
}
