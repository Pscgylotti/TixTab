import type { Page } from './model';
export function loadBlankPaper(): Page['paper'] {
  try {
    const paper = localStorage.getItem('tixtab.blankPaper');
    if (paper === 'plain' || paper === 'lines') return paper;
  } catch {}
  return 'dots';
}
export function saveBlankPaper(paper: Page['paper']) {
  try {
    localStorage.setItem('tixtab.blankPaper', paper);
  } catch {}
}
