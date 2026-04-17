import * as XLSX from 'xlsx';
import { getConfidenceLabel, getConfidenceLevel } from './evaluation';
import type { GroupedOpportunityRow, GroupedSuggestionItem } from './types';

const SUGGESTION_CSV_HEADERS = [
  'Site',
  'Site ID',
  'Opportunity Type',
  'Opportunity ID',
  'Suggestion IDs',
  'Suggestions',
  'Status',
  'Accepted',
  'Hallucinated',
  'Notes',
] as const;
const SUGGESTION_EXCEL_HEADERS = [
  'Site',
  'Site ID',
  'Opportunity Type',
  'Opportunity ID',
  'Suggestion IDs',
  'Suggestions',
  'Status',
  'Review Status',
  'Assignee',
  'Accepted',
  'Hallucinated',
  'Notes',
] as const;
const SENTIMENT_CSV_HEADERS = [
  'Site',
  'Site ID',
  'Opportunity Type',
  'Opportunity ID',
  'Url',
  'SOV',
  'Sentiment',
  'Evaluated SOV',
  'SOV Confidence',
  'Evaluated Sentiment',
  'Sentiment Confidence',
  'Evaluation Notes',
  'Evaluated At',
  'Status',
  'Review Status',
  'Assignee',
  'Accepted',
  'Hallucinated',
  'Notes',
] as const;
const SENTIMENT_EXCEL_HEADERS = [
  'Site',
  'Site ID',
  'Opportunity Type',
  'Opportunity ID',
  'Url',
  'SOV',
  'Sentiment',
  'Evaluated SOV',
  'SOV Confidence',
  'Evaluated Sentiment',
  'Sentiment Confidence',
  'Evaluation Notes',
  'Evaluated At',
  'Status',
  'Review Status',
  'Assignee',
  'Accepted',
  'Hallucinated',
  'Notes',
] as const;
const SENTIMENT_OPPORTUNITY_TYPES = new Set([
  'Reddit',
  'YouTube',
  'Cited URLs',
]);
const MIN_EXCEL_COLUMN_WIDTH = 14;
const MAX_EXCEL_COLUMN_WIDTH = 60;
const HEADER_ROW_HEIGHT_POINTS = 24;
const DEFAULT_ROW_HEIGHT_POINTS = 20;
const ROW_HEIGHT_PER_LINE_POINTS = 15;
const MAX_ROW_HEIGHT_POINTS = 320;
const EXPORT_ASSIGNEE = 'Liam the Evaluator';

type ExcelSheetOptions = {
  expandRows?: boolean;
  wrapText?: boolean;
};

function escapeCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function formatSuggestionIds(row: GroupedOpportunityRow) {
  return row.suggestions
    .map((suggestion) => suggestion.suggestionId?.trim())
    .filter(Boolean)
    .join('\n');
}

function formatSuggestions(row: GroupedOpportunityRow) {
  if (row.suggestions.length === 0) {
    return 'No suggestions returned';
  }

  return row.suggestions
    .map((suggestion, index) => {
      const parts: string[] = [];

      if (suggestion.suggestionId?.trim()) {
        parts.push(`ID: ${suggestion.suggestionId.trim()}`);
      }

      if (suggestion.suggestionText?.trim()) {
        parts.push(suggestion.suggestionText.trim());
      }

      if (suggestion.suggestionUrl?.trim()) {
        parts.push(`URL: ${suggestion.suggestionUrl.trim()}`);
      }

      if (parts.length === 0) {
        return `${index + 1}.`;
      }

      return `${index + 1}.\n${parts.join('\n')}`;
    })
    .join('\n\n');
}

function formatRow(row: GroupedOpportunityRow) {
  return [
    row.site,
    row.siteId ?? '',
    row.opportunityType ?? '',
    row.opportunityId ?? '',
    formatSuggestionIds(row),
    formatSuggestions(row),
    row.status,
    '',
    '',
    '',
  ];
}

function formatSuggestionRows(rows: GroupedOpportunityRow[]) {
  return rows.map(formatRow);
}

function normalizeComparableExportValue(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isHighConfidence(score?: number) {
  return getConfidenceLevel(score) === 'high';
}

function buildSuggestionEvaluationNote(suggestion: GroupedSuggestionItem) {
  const parts: string[] = [];

  if (suggestion.suggestionId?.trim()) {
    parts.push(`Suggestion ID: ${suggestion.suggestionId.trim()}`);
  }

  if (suggestion.evaluationError) {
    parts.push(`Verdict: Error`);
    parts.push(`Evidence: ${suggestion.evaluationError}`);
    return parts.join('\n');
  }

  if (!suggestion.evaluationResult) {
    return '';
  }

  parts.push(`Verdict: ${suggestion.evaluationResult.verdict}`);

  const confidenceLabel = getConfidenceLabel(suggestion.evaluationResult.confidence);
  if (confidenceLabel) {
    parts.push(`Confidence: ${confidenceLabel}`);
  }

  if (suggestion.evaluationResult.evidenceSnippet.trim()) {
    parts.push(`Evidence: ${suggestion.evaluationResult.evidenceSnippet.trim()}`);
  }

  return parts.join('\n');
}

function deriveSuggestionExportMetadata(row: GroupedOpportunityRow) {
  const evaluatedSuggestions = row.suggestions.filter(
    (suggestion) => suggestion.evaluationResult || suggestion.evaluationError,
  );
  const hasIncorrectSuggestion = row.suggestions.some(
    (suggestion) => suggestion.evaluationResult?.verdict === 'Incorrect',
  );
  const hasMediumOrLowConfidenceSuggestion = row.suggestions.some((suggestion) => {
    const result = suggestion.evaluationResult;
    return result ? getConfidenceLevel(result.confidence) !== 'high' : false;
  });
  const hasNeedsReviewSuggestion = row.suggestions.some(
    (suggestion) => suggestion.evaluationResult?.verdict === 'Needs Review',
  );
  const allSuggestionsAccepted =
    evaluatedSuggestions.length > 0 &&
    row.suggestions.every((suggestion) => {
      const result = suggestion.evaluationResult;
      return result
        ? result.verdict === 'Correct' && isHighConfidence(result.confidence)
        : false;
    });
  const notes = evaluatedSuggestions.map(buildSuggestionEvaluationNote).filter(Boolean).join('\n\n');

  return {
    reviewStatus:
      allSuggestionsAccepted
        ? 'DONE'
        : evaluatedSuggestions.length > 0 ||
            hasIncorrectSuggestion ||
            hasMediumOrLowConfidenceSuggestion ||
            hasNeedsReviewSuggestion
          ? 'IN REVIEW'
          : '',
    accepted: allSuggestionsAccepted ? 'YES' : evaluatedSuggestions.length > 0 ? 'NO' : '',
    hallucinated: hasIncorrectSuggestion ? 'TRUE' : allSuggestionsAccepted ? 'FALSE' : '',
    notes,
  };
}

function deriveSentimentExportMetadata(item: GroupedOpportunityRow['sentimentItems'][number]) {
  const evaluationResult = item.evaluationResult;
  const sentimentMatches = evaluationResult
    ? normalizeComparableExportValue(item.sentiment) ===
      normalizeComparableExportValue(evaluationResult.evaluatedSentiment)
    : false;
  const sovMatches = evaluationResult
    ? normalizeComparableExportValue(item.sov) ===
      normalizeComparableExportValue(evaluationResult.evaluatedSov)
    : false;
  const hasHighConfidenceMatch =
    Boolean(evaluationResult) &&
    isHighConfidence(evaluationResult?.sentimentConfidence) &&
    isHighConfidence(evaluationResult?.sovConfidence) &&
    sentimentMatches &&
    sovMatches;
  const hasExplicitMismatch =
    Boolean(evaluationResult) &&
    ((!sentimentMatches &&
      normalizeComparableExportValue(evaluationResult?.evaluatedSentiment ?? '') !==
        'needs review') ||
      (!sovMatches &&
        normalizeComparableExportValue(evaluationResult?.evaluatedSov ?? '') !==
          'needs review'));
  const hasEvaluation = Boolean(evaluationResult || item.evaluationError);

  return {
    reviewStatus: hasHighConfidenceMatch ? 'DONE' : hasEvaluation ? 'IN REVIEW' : '',
    accepted: hasHighConfidenceMatch ? 'YES' : hasEvaluation ? 'NO' : '',
    hallucinated: hasHighConfidenceMatch
      ? 'FALSE'
      : hasExplicitMismatch
        ? 'TRUE'
        : '',
    notes: [
      evaluationResult
        ? `Sentiment verdict: ${
            sentimentMatches
              ? 'Correct'
              : normalizeComparableExportValue(evaluationResult.evaluatedSentiment) ===
                  'needs review'
                ? 'Needs Review'
                : 'Incorrect'
          }`
        : '',
      evaluationResult
        ? `SOV verdict: ${
            sovMatches
              ? 'Correct'
              : normalizeComparableExportValue(evaluationResult.evaluatedSov) ===
                  'needs review'
                ? 'Needs Review'
                : 'Incorrect'
          }`
        : '',
      evaluationResult?.evidenceSnippet
        ? `Evidence: ${evaluationResult.evidenceSnippet}`
        : '',
      item.evaluationError ? `Evidence: ${item.evaluationError}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function formatSuggestionExcelRows(rows: GroupedOpportunityRow[]) {
  return rows.map((row) => {
    const baseRow = formatRow(row);
    const metadata = deriveSuggestionExportMetadata(row);

    return [
      ...baseRow.slice(0, 7),
      metadata.reviewStatus,
      EXPORT_ASSIGNEE,
      metadata.accepted,
      metadata.hallucinated,
      metadata.notes,
    ];
  });
}

function formatSentimentRows(rows: GroupedOpportunityRow[]) {
  return rows.flatMap((row) => {
    if (row.sentimentItems.length === 0) {
      return [
        [
          row.site,
          row.siteId ?? '',
          row.opportunityType ?? '',
          row.opportunityId ?? '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          row.status,
          '',
          '',
          EXPORT_ASSIGNEE,
          '',
          '',
          '',
        ],
      ];
    }

    return row.sentimentItems.map((item, index) => {
      const metadata = deriveSentimentExportMetadata(item);
      return [
        index === 0 ? row.site : '',
        index === 0 ? row.siteId ?? '' : '',
        index === 0 ? row.opportunityType ?? '' : '',
        index === 0 ? row.opportunityId ?? '' : '',
        item.item.trim(),
        item.sov.trim(),
        item.sentiment.trim(),
        item.evaluationResult?.evaluatedSov ?? '',
        item.evaluationResult
          ? getConfidenceLabel(item.evaluationResult.sovConfidence)
          : '',
        item.evaluationResult?.evaluatedSentiment ?? '',
        item.evaluationResult
          ? getConfidenceLabel(item.evaluationResult.sentimentConfidence)
          : '',
        [
          item.evaluationError ? `Error: ${item.evaluationError}` : '',
          item.evaluationResult?.rationale ?? '',
          item.evaluationResult?.fetch.transcriptStatus
            ? `Transcript status: ${item.evaluationResult.fetch.transcriptStatus}`
            : '',
          item.evaluationResult?.evidenceSnippet
            ? `Evidence: ${item.evaluationResult.evidenceSnippet}`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        item.evaluationResult?.evaluatedAt ?? '',
        index === 0 ? row.status : '',
        metadata.reviewStatus,
        EXPORT_ASSIGNEE,
        metadata.accepted,
        metadata.hallucinated,
        metadata.notes,
      ];
    });
  });
}

function getSentimentExportRows(rows: GroupedOpportunityRow[]) {
  const sentimentRows = rows.filter((row) =>
    row.opportunityType
      ? SENTIMENT_OPPORTUNITY_TYPES.has(row.opportunityType)
      : false,
  );

  return formatSentimentRows(sentimentRows);
}

function getSentimentExcelExportRows(rows: GroupedOpportunityRow[]) {
  const sentimentRows = rows.filter((row) =>
    row.opportunityType
      ? SENTIMENT_OPPORTUNITY_TYPES.has(row.opportunityType)
      : false,
  );

  return formatSentimentRows(sentimentRows);
}

function downloadCsvFile(
  headers: readonly string[],
  rows: string[][],
  filename: string,
) {
  const headerRow = headers.map((header) => escapeCell(header)).join(',');
  const bodyRows = rows.map((row) =>
    row.map((value) => escapeCell(String(value))).join(','),
  );
  const csvContent = [headerRow, ...bodyRows].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function getExcelColumnWidths(headers: readonly string[], rows: string[][]) {
  return headers.map((header, columnIndex) => {
    const columnWidth = rows.reduce((maxWidth, row) => {
      const cellValue = String(row[columnIndex] ?? '');
      const longestLine = cellValue
        .split('\n')
        .reduce((lineWidth, line) => Math.max(lineWidth, line.length), 0);

      return Math.max(maxWidth, longestLine);
    }, header.length);

    return Math.min(
      Math.max(columnWidth + 2, MIN_EXCEL_COLUMN_WIDTH),
      MAX_EXCEL_COLUMN_WIDTH,
    );
  });
}

function estimateWrappedLineCount(value: string, columnWidth: number) {
  const effectiveColumnWidth = Math.max(columnWidth - 2, 1);

  return value.split('\n').reduce((lineCount, line) => {
    const safeLineLength = Math.max(line.length, 1);

    return lineCount + Math.max(1, Math.ceil(safeLineLength / effectiveColumnWidth));
  }, 0);
}

function applyCellWrapping(worksheet: XLSX.WorkSheet) {
  const worksheetRef = worksheet['!ref'];

  if (!worksheetRef) {
    return;
  }

  const range = XLSX.utils.decode_range(worksheetRef);

  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
      const cellAddress = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const cell = worksheet[cellAddress] as XLSX.CellObject | undefined;

      if (!cell) {
        continue;
      }

      cell.s = {
        ...(cell.s ?? {}),
        alignment: {
          ...(cell.s?.alignment ?? {}),
          vertical: 'top',
          wrapText: true,
        },
      };
    }
  }
}

function applyAutoRowHeights(
  worksheet: XLSX.WorkSheet,
  rows: string[][],
  columnWidths: number[],
) {
  worksheet['!rows'] = [
    { hpt: HEADER_ROW_HEIGHT_POINTS },
    ...rows.map((row) => {
      const visualLineCount = row.reduce((maxLineCount, value, columnIndex) => {
        const lineCount = estimateWrappedLineCount(
          String(value ?? ''),
          columnWidths[columnIndex] ?? MIN_EXCEL_COLUMN_WIDTH,
        );

        return Math.max(maxLineCount, lineCount);
      }, 1);

      return {
        hpt: Math.min(
          Math.max(
            DEFAULT_ROW_HEIGHT_POINTS,
            visualLineCount * ROW_HEIGHT_PER_LINE_POINTS,
          ),
          MAX_ROW_HEIGHT_POINTS,
        ),
      };
    }),
  ];
}

function buildExcelSheet(
  headers: readonly string[],
  rows: string[][],
  options: ExcelSheetOptions = {},
) {
  const worksheet = XLSX.utils.aoa_to_sheet([Array.from(headers), ...rows]);
  const columnWidths = getExcelColumnWidths(headers, rows);

  worksheet['!cols'] = columnWidths.map((columnWidth) => ({ wch: columnWidth }));

  if (options.wrapText) {
    applyCellWrapping(worksheet);
  }

  if (options.expandRows) {
    applyAutoRowHeights(worksheet, rows, columnWidths);
  }

  return worksheet;
}

export function downloadRowsAsCsv(rows: GroupedOpportunityRow[]) {
  if (!rows.length) {
    return;
  }

  downloadCsvFile(
    SUGGESTION_CSV_HEADERS,
    formatSuggestionRows(rows),
    'Off-Site Evaluation Suggestions.csv',
  );
  downloadCsvFile(
    SENTIMENT_CSV_HEADERS,
    getSentimentExportRows(rows),
    'Off-Site Evaluation Sentiment.csv',
  );
}

export function downloadRowsAsExcel(rows: GroupedOpportunityRow[]) {
  if (!rows.length) {
    return;
  }

  const workbook = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    workbook,
    buildExcelSheet(SUGGESTION_EXCEL_HEADERS, formatSuggestionExcelRows(rows), {
      expandRows: true,
      wrapText: true,
    }),
    'EvaluationSuggestion',
  );
  XLSX.utils.book_append_sheet(
    workbook,
    buildExcelSheet(
      SENTIMENT_EXCEL_HEADERS,
      getSentimentExcelExportRows(rows),
      {
        expandRows: true,
        wrapText: true,
      },
    ),
    'EvaluationSentiment',
  );

  XLSX.writeFile(workbook, 'Off-Site Evaluation.xlsx', { cellStyles: true });
}

const SUGGESTION_EVAL_HEADERS = [
  'Site',
  'Site ID',
  'Opportunity Type',
  'Opportunity ID',
  'Suggestion ID',
  'Suggestion',
  'Suggestion URL',
  'Verdict',
  'Confidence',
  'Rationale',
  'Evidence Snippet',
  'Corrected Suggestion',
  'Sources Used',
  'Evaluated At',
  'Status',
] as const;

const SENTIMENT_EVAL_HEADERS = [
  'Site',
  'Site ID',
  'Opportunity Type',
  'Opportunity ID',
  'Url',
  'Extracted Sentiment',
  'Evaluated Sentiment',
  'Sentiment Confidence',
  'Sentiment Verdict',
  'Rationale',
  'Evidence Snippet',
  'Fetch Status',
  'Evaluated At',
  'Status',
] as const;

const SOV_EVAL_HEADERS = [
  'Site',
  'Site ID',
  'Opportunity Type',
  'Opportunity ID',
  'Url',
  'Extracted SOV',
  'Evaluated SOV',
  'SOV Confidence',
  'Target Brand Share %',
  'SOV Verdict',
  'Rationale',
  'Evidence Snippet',
  'Fetch Status',
  'Evaluated At',
  'Status',
] as const;

function formatSuggestionEvaluationRow(
  row: GroupedOpportunityRow,
  suggestion: GroupedSuggestionItem,
) {
  const result = suggestion.evaluationResult;
  const sources =
    result?.evidenceSources
      ?.map((source) => source.sourceUrl)
      .filter(Boolean)
      .join('\n') ?? '';

  return [
    row.site,
    row.siteId ?? '',
    row.opportunityType ?? '',
    row.opportunityId ?? '',
    suggestion.suggestionId?.trim() ?? '',
    suggestion.suggestionText?.trim() ?? '',
    suggestion.suggestionUrl?.trim() ?? '',
    result?.verdict ?? (suggestion.evaluationError ? 'Error' : 'Not evaluated'),
    result ? getConfidenceLabel(result.confidence) : '',
    result?.rationale?.trim() ?? suggestion.evaluationError ?? '',
    result?.evidenceSnippet?.trim() ?? '',
    result?.correctedSuggestion?.trim() ?? '',
    sources,
    result?.evaluatedAt ?? '',
    row.status,
  ];
}

function buildSuggestionEvaluationSheet(
  rows: GroupedOpportunityRow[],
  matchType: (opportunityType?: string) => boolean,
) {
  return rows
    .filter((row) => matchType(row.opportunityType))
    .flatMap((row) =>
      row.suggestions
        .filter(
          (suggestion) => suggestion.evaluationResult || suggestion.evaluationError,
        )
        .map((suggestion) => formatSuggestionEvaluationRow(row, suggestion)),
    );
}

export function downloadSuggestionEvaluationExcel(
  rows: GroupedOpportunityRow[],
) {
  const dataRows = buildSuggestionEvaluationSheet(rows, (type) => !!type);

  if (dataRows.length === 0) {
    return;
  }

  const workbook = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    workbook,
    buildExcelSheet(SUGGESTION_EVAL_HEADERS, dataRows, {
      expandRows: true,
      wrapText: true,
    }),
    'Suggestions',
  );

  XLSX.writeFile(workbook, 'Off-Site Suggestion Evaluation.xlsx', {
    cellStyles: true,
  });
}

function compareSentimentValue(left: string, right: string) {
  const leftValue = normalizeComparableExportValue(left);
  const rightValue = normalizeComparableExportValue(right);

  if (!leftValue || !rightValue) {
    return 'Not evaluated';
  }

  if (rightValue === 'needs review') {
    return 'Needs Review';
  }

  return leftValue === rightValue ? 'Correct' : 'Incorrect';
}

function formatSentimentEvaluationRows(rows: GroupedOpportunityRow[]) {
  return rows
    .filter((row) =>
      row.opportunityType ? SENTIMENT_OPPORTUNITY_TYPES.has(row.opportunityType) : false,
    )
    .flatMap((row) =>
      row.sentimentItems
        .filter((item) => item.evaluationResult || item.evaluationError)
        .map((item) => {
          const result = item.evaluationResult;
          return [
            row.site,
            row.siteId ?? '',
            row.opportunityType ?? '',
            row.opportunityId ?? '',
            item.item.trim(),
            item.sentiment.trim(),
            result?.evaluatedSentiment ?? '',
            result ? getConfidenceLabel(result.sentimentConfidence) : '',
            result
              ? compareSentimentValue(item.sentiment, result.evaluatedSentiment)
              : item.evaluationError
                ? 'Error'
                : 'Not evaluated',
            result?.rationale?.trim() ?? item.evaluationError ?? '',
            result?.evidenceSnippet?.trim() ?? '',
            result?.fetch.status ?? '',
            result?.evaluatedAt ?? '',
            row.status,
          ];
        }),
    );
}

function formatSovEvaluationRows(rows: GroupedOpportunityRow[]) {
  return rows
    .filter((row) =>
      row.opportunityType ? SENTIMENT_OPPORTUNITY_TYPES.has(row.opportunityType) : false,
    )
    .flatMap((row) =>
      row.sentimentItems
        .filter((item) => item.evaluationResult || item.evaluationError)
        .map((item) => {
          const result = item.evaluationResult;
          const targetBrandShare =
            typeof result?.evaluatedTargetBrandSharePct === 'number'
              ? `${result.evaluatedTargetBrandSharePct.toFixed(1)}%`
              : '';
          return [
            row.site,
            row.siteId ?? '',
            row.opportunityType ?? '',
            row.opportunityId ?? '',
            item.item.trim(),
            item.sov.trim(),
            result?.evaluatedSov ?? '',
            result ? getConfidenceLabel(result.sovConfidence) : '',
            targetBrandShare,
            result
              ? compareSentimentValue(item.sov, result.evaluatedSov)
              : item.evaluationError
                ? 'Error'
                : 'Not evaluated',
            result?.rationale?.trim() ?? item.evaluationError ?? '',
            result?.evidenceSnippet?.trim() ?? '',
            result?.fetch.status ?? '',
            result?.evaluatedAt ?? '',
            row.status,
          ];
        }),
    );
}

export function downloadSentimentEvaluationExcel(rows: GroupedOpportunityRow[]) {
  const dataRows = formatSentimentEvaluationRows(rows);

  if (dataRows.length === 0) {
    return;
  }

  const workbook = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    workbook,
    buildExcelSheet(SENTIMENT_EVAL_HEADERS, dataRows, {
      expandRows: true,
      wrapText: true,
    }),
    'SentimentEvaluations',
  );

  XLSX.writeFile(workbook, 'Off-Site Sentiment Evaluation.xlsx', {
    cellStyles: true,
  });
}

export function downloadSovEvaluationExcel(rows: GroupedOpportunityRow[]) {
  const dataRows = formatSovEvaluationRows(rows);

  if (dataRows.length === 0) {
    return;
  }

  const workbook = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    workbook,
    buildExcelSheet(SOV_EVAL_HEADERS, dataRows, {
      expandRows: true,
      wrapText: true,
    }),
    'SovEvaluations',
  );

  XLSX.writeFile(workbook, 'Off-Site SOV Evaluation.xlsx', {
    cellStyles: true,
  });
}
