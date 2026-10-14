"""Short-lived, offline PDF content editor. No AI runtime or persistent PDF heap.

The main process owns all file paths. Requests select content by a fingerprint
recomputed from the supplied source; no renderer-provided PDF operators execute.
"""
import hashlib
import json
import math
import sys
from pathlib import Path

import pymupdf as fitz


def fingerprint(kind, payload):
    return kind + ':' + hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:24]


def overlaps(a, b):
    r = fitz.Rect(a) & fitz.Rect(b)
    return not r.is_empty and r.width > .05 and r.height > .05


def elements(page):
    result = []
    # Exclude image bytes from text extraction: inspection is geometry/text only.
    data = page.get_text('dict', flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES)
    for bi, block in enumerate(data['blocks']):
        for li, line in enumerate(block.get('lines', [])):
            for si, span in enumerate(line['spans']):
                if not span['text'].strip():
                    continue
                raw = list(span['bbox'])
                rect = fitz.Rect(raw) * page.rotation_matrix
                direction = line.get('dir', (1, 0))
                blocked = '' if abs(direction[0]-1) < .001 and abs(direction[1]) < .001 else 'rotated-text'
                result.append(dict(id=fingerprint('text', [bi, li, si, raw, span['text']]),
                    kind='text', rect=list(rect), raw=raw, text=span['text'], font=span['font'],
                    fontSize=span['size'], color='#%06x' % (span['color'] & 0xffffff),
                    origin=list(span['origin']), blocked=blocked))
    for i, info in enumerate(page.get_image_info(xrefs=True)):
        raw = list(info['bbox'])
        rect = fitz.Rect(raw) * page.rotation_matrix
        matrix = info['transform']
        # Skewed, reflected or clipped occurrences need operator-level editing.
        blocked = '' if info['xref'] and matrix[0] > 0 and matrix[3] > 0 and abs(matrix[1])+abs(matrix[2]) < .001 and page.rect.contains(rect) else 'complex-image'
        result.append(dict(id=fingerprint('image', [i, info['xref'], raw, list(matrix)]),
            kind='image', rect=list(rect), raw=raw, xref=info['xref'], blocked=blocked))
    if len(result) > 4096:
        raise ValueError('element-limit')
    return result


def check_editable(doc):
    if doc.needs_pass or not (doc.permissions & fitz.PDF_PERM_MODIFY):
        raise ValueError('pdf-permissions')
    for i in range(1, doc.xref_length()):
        if doc.xref_get_key(i, 'ByteRange')[0] != 'null':
            raise ValueError('signed-edit')


def rect_request(value, page):
    if not isinstance(value, list) or len(value) != 4 or not all(isinstance(n, (int,float)) and math.isfinite(n) for n in value):
        raise ValueError('invalid-rect')
    r = fitz.Rect(value)
    if r.is_empty or r.width < 1 or r.height < 1 or not page.rect.contains(r):
        raise ValueError('invalid-rect')
    return r * page.derotation_matrix


def replacement_font(doc, page, item, text, cache):
    standard={'helvetica':'helv','helvetica-bold':'hebo','helvetica-oblique':'heit','helvetica-boldoblique':'hebi',
              'times-roman':'tiro','times-bold':'tibo','times-italic':'tiit','times-bolditalic':'tibi',
              'courier':'cour','courier-bold':'cobo','courier-oblique':'coit','courier-boldoblique':'cobi'}
    original=item['font'].split('+')[-1]
    name=standard.get(original.lower())
    if name:
        if name not in cache:cache[name]=(fitz.Font(name),None)
        font=cache[name][0]
        if all(font.has_glyph(ord(c)) for c in text if not c.isspace()): return name,font,None,''
    page_key=('page',page.number)
    if page_key not in cache:cache[page_key]=page.get_fonts(full=True)
    for entry in cache[page_key]:
        if entry[3].split('+')[-1].lower()!=original.lower(): continue
        try:
            key=('font',entry[0])
            if key not in cache:
                buffer=doc.extract_font(entry[0])[3]
                cache[key]=(fitz.Font(fontbuffer=buffer),buffer) if buffer else (None,None)
            font,buffer=cache[key]
            if not font: continue
            # A Type1 program must remain a simple font for Latin text. Wrapping
            # it as Identity-H CIDFontType0 changes glyph numbering in PDF.js.
            # Non-Latin Type1 edits require a full compatible fallback font.
            if buffer[:1] in (b'%',b'\x80') and any(ord(c)>255 and not c.isspace() for c in text): continue
            if all(font.has_glyph(ord(c)) for c in text if not c.isspace()):
                return 'TixTabEdit'+str(entry[0]),font,buffer,''
        except (ValueError,RuntimeError): pass
    family=original.lower()
    bold=bool(item.get('flags',0)&16) or 'bold' in family
    italic=bool(item.get('flags',0)&2) or any(part in family for part in ['italic','oblique'])
    serif=bool(item.get('flags',0)&4) or any(part in family for part in ['roman','times','cmr','lmr','stix','nimbusrom'])
    mono=bool(item.get('flags',0)&8) or any(part in family for part in ['courier','mono','nimbusmon'])
    name='china-s' if any(ord(c)>255 and not c.isspace() for c in text) else (
        ('cobi' if italic else 'cobo') if bold else ('coit' if italic else 'cour')) if mono else (
        ('tibi' if italic else 'tibo') if bold else ('tiit' if italic else 'tiro')) if serif else (
        ('hebi' if italic else 'hebo') if bold else ('heit' if italic else 'helv'))
    if name not in cache:cache[name]=(fitz.Font(name),None)
    return name,cache[name][0],None,'font-replaced'


def prepare_edit(doc, page, request, all_elements=None, font_cache=None, editable_checked=False):
    if not editable_checked:check_editable(doc)
    all_elements = elements(page) if all_elements is None else all_elements
    item = next((e for e in all_elements if e['id'] == request.get('elementId')), None)
    if not item:
        raise ValueError('element-stale')
    if item['blocked']:
        raise ValueError(item['blocked'])
    area = fitz.Rect(item['raw'])
    # Redaction is occurrence-local, unlike replace_image(xref), which changes all
    # uses of a shared image. Never silently erase another overlapping occurrence.
    same = [e for e in all_elements if e['id'] != item['id'] and e['kind'] == item['kind'] and overlaps(e['raw'],area)]
    if same:
        raise ValueError('overlapping-elements')
    # Do not apply user-authored redactions as a side effect of a content edit.
    if any(a.type[0] == fitz.PDF_ANNOT_REDACT for a in (page.annots() or [])):
        raise ValueError('pending-redactions')
    delete = request.get('delete') is True
    target = None if delete else rect_request(request.get('rect',item['rect']),page)
    image_bytes = None
    font_name = 'helv'
    font_buffer = None
    warning = ''
    text = request.get('text',item.get('text',''))
    font_size = request.get('fontSize',item.get('fontSize',12))
    color = request.get('color',item.get('color','#000000'))
    if not delete and item['kind'] == 'text':
        if not isinstance(text,str) or len(text) > 10000 or not text.strip():
            raise ValueError('invalid-text')
        if not isinstance(font_size,(float,int)) or not math.isfinite(font_size) or not 1 <= font_size <= 300:
            raise ValueError('invalid-font')
        if not isinstance(color,str) or len(color) != 7 or color[0] != '#':
            raise ValueError('invalid-color')
        try:
            ink = tuple(int(color[i:i+2],16)/255 for i in (1,3,5))
        except ValueError:
            raise ValueError('invalid-color')
        # Embedded subsets often omit newly typed glyphs. Use a full font for
        # replacement, tell the UI, and fail transactionally if it cannot fit.
        font_name,font,font_buffer,warning=replacement_font(doc,page,item,text,{} if font_cache is None else font_cache)
        if any(not font.has_glyph(ord(c)) for c in text if not c.isspace()):
            raise ValueError('unsupported-glyph')
        lines = text.replace('\r\n','\n').split('\n')
        baseline_offset = (item['origin'][1]-area.y0) * font_size / item['fontSize']
        baseline_x = (item['origin'][0]-area.x0) * font_size / item['fontSize']
        if not request.get('overflow') and (max(font.text_length(line,fontsize=font_size) for line in lines) > target.width+.1 or baseline_offset+(len(lines)-1)*font_size*1.25+max(.2,font.descender*-font_size) > target.height+.5):
            raise ValueError('text-does-not-fit')
    elif not delete:
        replacement = request.get('replacement')
        if replacement:
            import base64
            if not isinstance(replacement,str) or not replacement.startswith('data:image/png;base64,') or len(replacement)>48*1024*1024:
                raise ValueError('invalid-image')
            image_bytes = base64.b64decode(replacement.split(',',1)[1],validate=True)
            pix = fitz.Pixmap(image_bytes)
            if pix.width*pix.height>32_000_000:
                raise ValueError('image-size')
        else:
            pix = fitz.Pixmap(doc,item['xref'])
            smask = doc.extract_image(item['xref']).get('smask',0)
            if smask:
                pix = fitz.Pixmap(pix,fitz.Pixmap(doc,smask))
            if pix.colorspace and pix.colorspace.n>3:
                pix=fitz.Pixmap(fitz.csRGB,pix)
            image_bytes=pix.tobytes('png')
    # Transparent redaction; preserve images/line art for text edits, preserve
    # text/line art for image edits. Only serialize after replacement succeeds.
    def insert():
        if not delete:
            if item['kind']=='text':
                if font_buffer:
                    simple=font_buffer[:1] in (b'%',b'\x80')
                    xref=page.insert_font(fontname=font_name,fontbuffer=font_buffer,set_simple=simple)
                    # Some PDF subsets omit a space glyph, using TJ positioning
                    # in the source. MuPDF gives inserted spaces CID 0; its
                    # default CMap otherwise makes copied/searchable text NUL.
                    # All non-whitespace glyphs were validated before mutation.
                    if not simple and not font.has_glyph(32):
                        kind,value=doc.xref_get_key(xref,'ToUnicode')
                        if kind=='xref':
                            cmap_xref=int(value.split()[0]);cmap=doc.xref_stream(cmap_xref)
                            marker=b'1 beginbfchar\n<0000> <0020>\nendbfchar\n'
                            if marker not in cmap:doc.update_stream(cmap_xref,cmap.replace(b'endcmap',marker+b'endcmap'))
                for i,line in enumerate(lines):
                    page.insert_text((target.x0+baseline_x,target.y0+baseline_offset+i*font_size*1.25),line,
                        fontname=font_name,fontsize=font_size,color=ink,overlay=True)
            else:
                page.insert_image(target,stream=image_bytes,keep_proportion=False,overlay=True)
    return dict(kind=item['kind'],area=area,insert=insert,warning=warning)


def apply_prepared(page, prepared):
    # Remove all original occurrences before inserting any replacement. This
    # keeps later redactions from erasing an earlier moved/replacement element.
    for kind in ['text','image']:
        matching=[item for item in prepared if item['kind']==kind]
        for item in matching: page.add_redact_annot(item['area'],fill=False,cross_out=False)
        if matching: page.apply_redactions(images=1 if kind=='image' else 0,graphics=0,text=0 if kind=='text' else 1)
    for kind in ['image','text']:
        for item in prepared:
            if item['kind']==kind: item['insert']()


def edit(doc, page, request):
    item=prepare_edit(doc,page,request)
    apply_prepared(page,[item])
    return item['warning']


def run(input_pdf, request, output_pdf):
    with fitz.open(input_pdf) as doc:
        if request.get('action') in ['batch','preview']:
            check_editable(doc)
            changes=request.get('edits')
            if not isinstance(changes,list) or not 1<=len(changes)<=256: raise ValueError('element-limit')
            by_page={}
            seen=set()
            for change in changes:
                if not isinstance(change,dict): raise ValueError('invalid')
                index=change.get('page')
                if not isinstance(index,int) or not 0<=index<len(doc): raise ValueError('page-range')
                key=(index,change.get('elementId'))
                if key in seen: raise ValueError('element-stale')
                seen.add(key)
                by_page.setdefault(index,[]).append(change)
            prepared={};font_cache={}
            # Validate the entire transaction against the original source first.
            for index,changes in by_page.items():
                page=doc[index]; original=elements(page)
                prepared[index]=(page,[prepare_edit(doc,page,change,original,font_cache,True) for change in changes])
            for page,items in prepared.values(): apply_prepared(page,items)
            if request['action']=='preview':
                import base64
                index=request.get('page')
                if not isinstance(index,int) or not 0<=index<len(doc): raise ValueError('page-range')
                page=doc[index]
                pixels=request.get('maxPixels',8000000);wanted=request.get('scale',3)
                if not isinstance(pixels,(int,float)) or not math.isfinite(pixels) or not 250000<=pixels<=12000000 or not isinstance(wanted,(int,float)) or not math.isfinite(wanted) or not .125<=wanted<=4: raise ValueError('invalid')
                scale=min(wanted,math.sqrt(pixels/max(1,page.rect.width*page.rect.height)))
                pix=page.get_pixmap(matrix=fitz.Matrix(scale,scale),alpha=False,colorspace=fitz.csRGB)
                polygons=[]
                for info in page.get_image_info():
                    matrix=fitz.Matrix(info['transform'])*page.rotation_matrix
                    points=[fitz.Point(x,y)*matrix for x,y in [(0,0),(1,0),(1,1),(0,1)]]
                    polygons.append([coordinate*scale for point in points for coordinate in point])
                return dict(preview='data:image/png;base64,'+base64.b64encode(pix.tobytes('png')).decode('ascii'),polygons=polygons,
                    warning='font-replaced' if any(item['warning'] for _,items in prepared.values() for item in items) else '')
            doc.save(output_pdf,garbage=3,deflate=True,encryption=fitz.PDF_ENCRYPT_KEEP)
            return dict(warning='font-replaced' if any(item['warning'] for _,items in prepared.values() for item in items) else '')
        index=request.get('page')
        if not isinstance(index,int) or index < 0 or index >= len(doc):
            raise ValueError('page-range')
        if doc.needs_pass:
            raise ValueError('pdf-permissions')
        page=doc[index]
        if request.get('action')=='inspect':
            return dict(elements=elements(page),width=page.rect.width,height=page.rect.height)
        if request.get('action')!='edit':
            raise ValueError('invalid')
        warning=edit(doc,page,request)
        doc.save(output_pdf,garbage=3,deflate=True,encryption=fitz.PDF_ENCRYPT_KEEP)
        return dict(warning=warning)


if __name__=='__main__':
    directory=Path(sys.argv[1])
    try:
        result=run(directory/'input.pdf',json.loads((directory/'request.json').read_text('utf-8')),directory/'output.pdf')
        result=dict(ok=True,data=result)
    except Exception as e:
        # Fixed error codes only; never echo PDF text or filesystem paths.
        allowed={'element-limit','pdf-permissions','signed-edit','invalid-rect','element-stale','rotated-text','complex-image','overlapping-elements','pending-redactions','invalid-text','invalid-font','invalid-color','unsupported-glyph','text-does-not-fit','invalid-image','image-size','page-range','invalid'}
        result=dict(ok=False,error=str(e) if str(e) in allowed else 'pdf-edit')
    (directory/'result.json').write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8')
