export function parseNodeGroups(group: string | null | undefined): string[] {
  return [...new Set((group || '').split(';').map(item => item.trim()).filter(Boolean))]
}

export function isNodeInGroup(group: string | null | undefined, selectedGroup: string): boolean {
  if (selectedGroup === 'all')
    return true
  return parseNodeGroups(group).includes(selectedGroup)
}
