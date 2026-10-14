export async function copyImage(data: string) {
  const response = await fetch(data);
  const blob = await response.blob();
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* Older desktop sessions may deny clipboard permissions. */
  }
  const selection = window.getSelection(),
    ranges = selection
      ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
      : [];
  const active = document.activeElement as HTMLElement | null,
    field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.style.cssText =
    'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(field);
  field.select();
  field.setSelectionRange(0, text.length);
  try {
    if (!document.execCommand('copy')) throw new Error('剪贴板不可用');
  } finally {
    field.remove();
    active?.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}
