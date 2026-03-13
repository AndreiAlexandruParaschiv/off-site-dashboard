import type { GroupedOpportunityRow } from './types';

const CSV_HEADERS = [
  'Site',
  'Site ID',
  'Opportunity Type',
  'Opportunity ID',
  'Suggestion IDs',
  'Suggestions',
  'Status',
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
  ];
}

function downloadCsvFile(rows: GroupedOpportunityRow[], filename: string) {
  const headerRow = CSV_HEADERS.map((header) => escapeCell(header)).join(',');
  const bodyRows = rows.map((row) =>
    formatRow(row).map((value) => escapeCell(String(value))).join(','),
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

export function downloadRowsAsCsv(rows: GroupedOpportunityRow[]) {
  if (!rows.length) {
    return;
  }

  const sentimentRows = rows.filter((row) =>
    row.opportunityType
      ? SENTIMENT_OPPORTUNITY_TYPES.has(row.opportunityType)
      : false,
  );
  downloadCsvFile(rows, 'EvaluationSuggestion.csv');
  downloadCsvFile(sentimentRows, 'EvaluationSentiment.csv');
}
