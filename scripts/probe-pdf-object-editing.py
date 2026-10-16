"""Probe backend/pdf_editor.py against a PDF that contains every common object type.

Usage: python probe_pdf_editor.py <worktree> <workdir>
"""
import io
import json
import sys
from pathlib import Path

import pymupdf as fitz

root, work = Path(sys.argv[1]), Path(sys.argv[2])
sys.path.insert(0, str(root / 'backend'))
import pdf_editor  # noqa: E402

work.mkdir(parents=True, exist_ok=True)


def png(color, size=(40, 30)):
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, *size), False)
    pix.set_rect(pix.irect, color)
    return pix.tobytes('png')


def build():
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    # Text: plain line, two spans with different fonts on one line, paragraph, CJK, rotated.
    page.insert_text((50, 60), 'Plain Helvetica line', fontname='helv', fontsize=14)
    page.insert_text((50, 90), 'Bold part', fontname='hebo', fontsize=12)
    page.insert_text((115, 90), 'regular part', fontname='helv', fontsize=12)
    page.insert_textbox(fitz.Rect(50, 100, 300, 160),
                        'A wrapped paragraph that spans several lines so that reflow behaviour can be checked.',
                        fontname='tiro', fontsize=11)
    page.insert_text((50, 190), '中文段落测试', fontname='china-s', fontsize=14)
    page.insert_text((400, 300), 'Rotated text', fontname='helv', fontsize=12, rotate=90)
    # Vector paths: filled rect, line, bezier, dashed stroke.
    shape = page.new_shape()
    shape.draw_rect(fitz.Rect(320, 50, 420, 110)); shape.finish(color=(0, 0, 1), fill=(0.8, 0.9, 1), width=2)
    shape.draw_line((320, 130), (500, 150)); shape.finish(color=(1, 0, 0), width=3)
    shape.draw_bezier((320, 170), (360, 120), (420, 220), (500, 170)); shape.finish(color=(0, 0.5, 0), width=2, dashes='[4 2] 0')
    shape.commit()
    # Images: plain, rotated, shared twice, clipped by raw content.
    blue = png((40, 90, 200))
    page.insert_image(fitz.Rect(50, 230, 170, 320), stream=blue)
    page.insert_image(fitz.Rect(200, 230, 290, 350), stream=png((200, 60, 40)), rotate=90)
    red = png((220, 40, 40))
    x1 = page.insert_image(fitz.Rect(50, 360, 130, 420), stream=red)
    page.insert_image(fitz.Rect(150, 360, 230, 420), xref=x1)
    # Form XObject: embed another page's content.
    src = fitz.open(); sp = src.new_page(width=200, height=100)
    sp.insert_text((10, 40), 'Inside form XObject', fontname='helv', fontsize=12)
    sp.draw_rect(fitz.Rect(5, 5, 195, 95), color=(0.5, 0, 0.5), width=1)
    page.show_pdf_page(fitz.Rect(320, 400, 520, 500), src, 0)
    # Shading and clipped image via raw content appended to the page.
    xref = doc.get_new_xref()
    doc.update_object(xref, '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 1 0] '
                      '/Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> /Extend [true true] >>')
    page.clean_contents()  # merge into one content stream
    doc.xref_set_key(page.xref, 'Resources/Shading', f'<< /Sh1 {xref} 0 R >>')
    # Highlight annotation.
    page.add_highlight_annot(fitz.Rect(50, 48, 200, 64))
    content = doc.xref_stream(page.get_contents()[0])
    content += b'\nq 50 540 m 250 540 l 250 600 l 50 600 l h W n 200 0 0 60 50 540 cm /Sh1 sh Q\n'
    doc.update_stream(page.get_contents()[0], content)
    out = work / 'probe.pdf'
    doc.save(out)
    return out


pdf = build()
results = {}
with fitz.open(pdf) as doc:
    page = doc[0]
    items = pdf_editor.elements(page)
    results['detected'] = [
        {'kind': e['kind'], 'text': e.get('text', '')[:40], 'blocked': e['blocked'] or None,
         'rect': [round(v) for v in e['rect']]} for e in items]
    results['paths_on_page'] = len(page.get_drawings())
    results['images_on_page'] = len(page.get_image_info())


def attempt(label, pick, change):
    with fitz.open(pdf) as doc:
        page = doc[0]
        items = pdf_editor.elements(page)
        item = pick(items)
        if not item:
            results.setdefault('edits', []).append({'case': label, 'result': 'not-detected'})
            return
        request = {'action': 'edit', 'page': 0, 'elementId': item['id'], 'overflow': True, **change(item)}
        try:
            out = work / f'{label}.pdf'
            pdf_editor.run(pdf, request, out)
            with fitz.open(out) as edited:
                text = edited[0].get_text()
            results.setdefault('edits', []).append({'case': label, 'result': 'ok', 'still_has_original_text': item.get('text', '') in text if item['kind'] == 'text' else None})
        except Exception as error:  # fixed codes from the editor
            results.setdefault('edits', []).append({'case': label, 'result': str(error)})


find = lambda pred: (lambda items: next((e for e in items if pred(e)), None))
move = lambda dx, dy: (lambda e: {'rect': [e['rect'][0] + dx, e['rect'][1] + dy, e['rect'][2] + dx, e['rect'][3] + dy]})
attempt('text-change', find(lambda e: e['kind'] == 'text' and e['text'].startswith('Plain')), lambda e: {'text': 'Changed line'})
attempt('text-move', find(lambda e: e['kind'] == 'text' and e['text'].startswith('Plain')), move(20, 300))
attempt('text-longer-reflow', find(lambda e: e['kind'] == 'text' and 'wrapped' in e['text']), lambda e: {'text': e['text'] + ' plus much more added text to force a reflow of the paragraph'})
attempt('span-of-mixed-line', find(lambda e: e['kind'] == 'text' and e['text'].startswith('Bold')), lambda e: {'text': 'Heavy part'})
attempt('cjk-change', find(lambda e: e['kind'] == 'text' and '中文' in e['text']), lambda e: {'text': '中文修改后'})
attempt('rotated-text', find(lambda e: e['kind'] == 'text' and 'Rotated' in e['text']), lambda e: {'text': 'Turned'})
attempt('form-xobject-text', find(lambda e: e['kind'] == 'text' and 'form XObject' in e['text']), lambda e: {'text': 'Form changed'})
attempt('image-move', find(lambda e: e['kind'] == 'image' and e['rect'][0] < 60 and e['rect'][1] < 240), move(0, 400))
attempt('image-rotated', find(lambda e: e['kind'] == 'image' and 190 < e['rect'][0] < 210), move(10, 0))
attempt('image-shared-delete', find(lambda e: e['kind'] == 'image' and e['rect'][1] > 350 and e['rect'][1] < 370), lambda e: {'delete': True})
(work / 'probe.json').write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding='utf-8')
