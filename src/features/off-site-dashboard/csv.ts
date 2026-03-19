import * as XLSX from 'xlsx';
import { getConfidenceLabel } from './evaluation';
import type { GroupedOpportunityRow } from './types';

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
  'Prompt Gap',
]);
const MIN_EXCEL_COLUMN_WIDTH = 14;
const MAX_EXCEL_COLUMN_WIDTH = 60;
const HEADER_ROW_HEIGHT_POINTS = 24;
const DEFAULT_ROW_HEIGHT_POINTS = 20;
const ROW_HEIGHT_PER_LINE_POINTS = 15;
const MAX_ROW_HEIGHT_POINTS = 320;

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

function formatSuggestionExcelRows(rows: GroupedOpportunityRow[]) {
  return formatSuggestionRows(rows).map((row) => [
    ...row.slice(0, 7),
    '',
    '',
    ...row.slice(7),
  ]);
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
          '',
          '',
          '',
        ],
      ];
    }

    return row.sentimentItems.map((item, index) => [
      index === 0 ? row.site : '',
      index === 0 ? row.siteId ?? '' : '',
      index === 0 ? row.opportunityType ?? '' : '',
      index === 0 ? row.opportunityId ?? '' : '',
      item.item.trim(),
      item.sov.trim(),
      item.sentiment.trim(),
      item.evaluationResult?.evaluatedSentiment ?? '',
      item.evaluationResult
        ? getConfidenceLabel(item.evaluationResult.sentimentConfidence)
        : '',
      [
        item.evaluationError ? `Error: ${item.evaluationError}` : '',
        item.evaluationResult?.rationale ?? '',
        item.evaluationResult?.evidenceSnippet
          ? `Evidence: ${item.evaluationResult.evidenceSnippet}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      item.evaluationResult?.evaluatedAt ?? '',
      index === 0 ? row.status : '',
      '',
      '',
      '',
      '',
      '',
    ]);
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
