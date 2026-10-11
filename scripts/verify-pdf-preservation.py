"""Independent pypdf validation of canonical fields, widget values and appearances."""
from pathlib import Path
from hashlib import sha256
import json
from pypdf import PdfReader

source=PdfReader('tmp/pdfs/preservation-source.pdf')

def widget_data(reader):
    result={}
    for page in reader.pages:
        for raw in page.get('/Annots',[]):
            widget=raw.get_object()
            if widget.get('/Subtype')!='/Widget':
                continue
            node=widget
            names=[]
            value=None
            seen=set()
            while node is not None:
                assert id(node) not in seen,'Cyclic field parent'
                seen.add(id(node))
                if '/T' in node:
                    names.insert(0,str(node['/T']))
                if value is None:
                    value=node.get('/V')
                parent=node.get('/Parent')
                node=parent.get_object() if parent else None
            key='.'.join(names)
            assert value is not None and key
            ap=widget['/AP']['/N'].get_object()
            def appearance(v):
                v=v.get_object()
                if hasattr(v,'get_data'):
                    return sha256(v.get_data()).hexdigest()
                return {str(k):appearance(raw) for k,raw in v.items()}
            result[key]={'value':str(value),'appearance':appearance(ap),'state':str(widget.get('/AS'))}
    return result

baseline=widget_data(source)
reports=[]
for path in ['tmp/pdfs/preservation-export.pdf','tmp/pdfs/ui-preservation-export.pdf','tmp/pdfs/overlay-export.pdf']:
    reader=PdfReader(path)
    fields=reader.get_fields()
    expected={f'group.field-{i}':f'value-{i}' for i in range(4)}|{'checked':'/Yes'}
    assert set(fields)==set(expected)|{'group'},list(fields)
    for key,value in expected.items():
        assert str(fields[key]['/V'])==value,(path,key)
    widgets=widget_data(reader)
    assert widgets=={key:baseline[key] for key in expected},path
    assert dict(reader.metadata)==dict(source.metadata),path
    assert reader.trailer['/Root']['/Metadata'].get_data()==source.trailer['/Root']['/Metadata'].get_data()
    extracted='\n'.join(p.extract_text() or '' for p in reader.pages)
    assert 'Original page 1' in extracted and 'REMOVED_PAGE_PRIVATE_TEXT' not in extracted
    serialized=Path(path).read_bytes()
    assert len(reader.pages) in (4,5)
    reports.append({'file':path,'pages':len(reader.pages),'canonicalFields':len(fields),'widgets':len(widgets),'valuesAndAppearances':'unchanged','metadataAndXmp':'unchanged','retainedTextSearchable':True,'removedPageTextAbsent':True,'bytes':len(serialized)})
print(json.dumps(reports,indent=2))
Path('tmp/pdfs/pypdf-preservation-report.json').write_text(json.dumps(reports,indent=2)+'\n',encoding='utf-8')
