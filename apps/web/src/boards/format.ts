const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function formatDateTime(iso: string): string {
  return formatter.format(new Date(iso));
}

export const roleLabels = {
  owner: 'Owner',
  editor: 'Editor',
  viewer: 'Viewer',
} as const;
