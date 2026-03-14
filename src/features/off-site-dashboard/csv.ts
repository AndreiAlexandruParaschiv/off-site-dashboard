import * as XLSX from 'xlsx';
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
const SENTIMENT_CSV_HEADERS = [
  'Site',
  'Site ID',
  'Opportunity Type',
  'Opportunity ID',
  'Url',
  'SOV',
  'Sentiment',
  'Status',
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

function formatSentimentRows(rows: GroupedOpportunityRow[]) {
  return rows.flatMap((row) => {
    if (row.sentimentItems.length === 0) {
      return [[
        row.site,
        row.siteId ?? '',
        row.opportunityType ?? '',
        row.opportunityId ?? '',
        '',
        '',
        '',
        row.status,
        '',
        '',
        '',
      ]];
    }

    return row.sentimentItems.map((item, index) => [
      index === 0 ? row.site : '',
      index === 0 ? row.siteId ?? '' : '',
      index === 0 ? row.opportunityType ?? '' : '',
      index === 0 ? row.opportunityId ?? '' : '',
      item.item.trim(),
      item.sov.trim(),
      item.sentiment.trim(),
      index === 0 ? row.status : '',
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

function buildExcelSheet(headers: readonly string[], rows: string[][]) {
  const worksheet = XLSX.utils.aoa_to_sheet([Array.from(headers), ...rows]);

  worksheet['!cols'] = headers.map((header, columnIndex) => {
    const columnWidth = rows.reduce((maxWidth, row) => {
      const cellValue = String(row[columnIndex] ?? '');
      const longestLine = cellValue
        .split('\n')
        .reduce((lineWidth, line) => Math.max(lineWidth, line.length), 0);

      return Math.max(maxWidth, longestLine);
    }, header.length);

    return { wch: Math.min(Math.max(columnWidth + 2, 14), 60) };
  });

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
    buildExcelSheet(SUGGESTION_CSV_HEADERS, formatSuggestionRows(rows)),
    'EvaluationSuggestion',
  );
  XLSX.utils.book_append_sheet(
    workbook,
    buildExcelSheet(SENTIMENT_CSV_HEADERS, getSentimentExportRows(rows)),
    'EvaluationSentiment',
  );

  XLSX.writeFile(workbook, 'Off-Site Evaluation.xlsx');
}
