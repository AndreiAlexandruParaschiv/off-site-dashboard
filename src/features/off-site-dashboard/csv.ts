import type { DashboardRow } from './types';

const CSV_HEADERS: Array<keyof DashboardRow> = [
  'site',
  'siteId',
  'opportunityType',
  'opportunityId',
  'suggestionId',
  'suggestionText',
  'suggestionUrl',
  'lastUpdated',
  'status',
];

function escapeCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

export function downloadRowsAsCsv(rows: DashboardRow[]) {
  if (!rows.length) {
    return;
  }

  const headerRow = CSV_HEADERS.map((header) => escapeCell(header)).join(',');
  const bodyRows = rows.map((row) =>
    CSV_HEADERS.map((header) => escapeCell(String(row[header] ?? ''))).join(','),
  );
  const csvContent = [headerRow, ...bodyRows].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'off-site-dashboard.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
