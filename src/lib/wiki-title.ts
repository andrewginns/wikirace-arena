export function normalizeWikiTitle(title: string) {
  return title
    .split('#', 1)[0]
    .replaceAll('_', ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFKC')
    .toLowerCase()
}

export function wikiTitlesMatch(a: string, b: string) {
  return normalizeWikiTitle(a) === normalizeWikiTitle(b)
}
