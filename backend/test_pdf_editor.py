import io
import tempfile
import unittest
from pathlib import Path
import pymupdf as fitz
from pdf_editor import run, elements


class PdfEditorTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.source=self.root/'input.pdf'
        self.output=self.root/'output.pdf'
        doc=fitz.open()
        for w,h in [(400,600),(600,400)]:
            page=doc.new_page(width=w,height=h)
            page.insert_text((40,60),'Original native text',fontsize=16)
            page.insert_text((40,100),'Untouched text',fontsize=16)
            pix=fitz.Pixmap(fitz.csRGB,fitz.IRect(0,0,80,40),0);pix.clear_with(0xff0000)
            # Same image resource is shared across pages and across occurrences.
            xref=page.insert_image(fitz.Rect(40,160,200,240),stream=pix.tobytes('png'))
            page.insert_image(fitz.Rect(230,160,390,240),xref=xref)
        doc.save(self.source);doc.close()

    def tearDown(self): self.temp.cleanup()

    def select(self,kind,index=0,page=0):
        return [e for e in run(self.source,{'action':'inspect','page':page},self.output)['elements'] if e['kind']==kind][index]

    def test_text_replacement_removes_old_searchable_content(self):
        e=self.select('text')
        run(self.source,dict(action='edit',page=0,elementId=e['id'],text='Replacement',fontSize=16,color='#123456',rect=[40,40,300,75]),self.output)
        with fitz.open(self.output) as doc:
            self.assertNotIn('Original',doc[0].get_text())
            self.assertIn('Replacement',doc[0].get_text())
            self.assertIn('Untouched text',doc[0].get_text())
            self.assertIn('Original native text',doc[1].get_text())
            self.assertEqual(len(doc[0].get_image_info()),2)
        with fitz.open(self.source) as doc:self.assertIn('Original native text',doc[0].get_text())

    def test_image_delete_is_local_to_occurrence(self):
        e=self.select('image')
        run(self.source,dict(action='edit',page=0,elementId=e['id'],delete=True),self.output)
        with fitz.open(self.output) as doc:
            self.assertEqual(len(doc[0].get_image_info()),1)
            self.assertEqual(len(doc[1].get_image_info()),2)
            self.assertIn('Untouched text',doc[0].get_text())

    def test_move_image_keeps_other_occurrences(self):
        e=self.select('image')
        run(self.source,dict(action='edit',page=0,elementId=e['id'],rect=[40,300,120,340]),self.output)
        with fitz.open(self.output) as doc:
            boxes=[list(i['bbox']) for i in doc[0].get_image_info()]
            self.assertIn([40.,300.,120.,340.],boxes)
            self.assertIn([230.,160.,390.,240.],boxes)
            self.assertEqual(len(doc[1].get_image_info()),2)

    def test_rotated_cropped_page_coordinates(self):
        with fitz.open(self.source) as doc:
            page=doc[0];page.set_cropbox(fitz.Rect(20,10,400,580));page.set_rotation(90)
            changed=self.root/'rotated.pdf';doc.save(changed)
        inspected=run(changed,{'action':'inspect','page':0},self.output)
        self.assertEqual((inspected['width'],inspected['height']),(570,380))
        e=next(e for e in inspected['elements'] if e['kind']=='text')
        result=run(changed,dict(action='edit',page=0,elementId=e['id'],text='New',rect=e['rect']),self.output)
        with fitz.open(self.output) as doc:
            self.assertIn('New',doc[0].get_text())
            new=next(e for e in elements(doc[0]) if e.get('text')=='New')
            self.assertAlmostEqual(new['rect'][0],e['rect'][0],delta=2)

    def test_overflow_is_transactional(self):
        e=self.select('text')
        with self.assertRaisesRegex(ValueError,'text-does-not-fit'):
            run(self.source,dict(action='edit',page=0,elementId=e['id'],text='Too long '*100,rect=e['rect']),self.output)
        self.assertFalse(self.output.exists())

    def test_batch_preview_overflow_and_single_commit(self):
        first=self.select('text',0);second=self.select('text',1);image=self.select('image')
        changes=[dict(page=0,elementId=first['id'],rect=[40,40,80,50],text='Overflow outside the original box',fontSize=16,color='#123456',overflow=True),
                 dict(page=0,elementId=second['id'],delete=True),dict(page=0,elementId=image['id'],rect=[40,300,200,380])]
        preview=run(self.source,dict(action='preview',page=0,edits=changes),self.output)
        self.assertTrue(preview['preview'].startswith('data:image/png;base64,'))
        self.assertFalse(self.output.exists())
        with fitz.open(self.source) as doc:self.assertIn('Original native text',doc[0].get_text())
        run(self.source,dict(action='batch',page=0,edits=changes),self.output)
        with fitz.open(self.output) as doc:
            self.assertIn('Overflow outside the original box',doc[0].get_text())
            self.assertNotIn('Original native text',doc[0].get_text())
            self.assertNotIn('Untouched text',doc[0].get_text())
            self.assertIn([40.,300.,200.,380.],[list(i['bbox']) for i in doc[0].get_image_info()])
        self.output.unlink()
        changes.append(dict(page=1,elementId='invalid',delete=True))
        with self.assertRaisesRegex(ValueError,'element-stale'):run(self.source,dict(action='batch',page=0,edits=changes),self.output)
        self.assertFalse(self.output.exists())

    def test_preserves_standard_serif_font_origin_and_requested_preview_density(self):
        source=self.root/'serif.pdf'
        doc=fitz.open();page=doc.new_page(width=400,height=600)
        page.insert_text((50,80),'Original serif',fontname='tiro',fontsize=18);doc.save(source);doc.close()
        e=run(source,dict(action='inspect',page=0),self.output)['elements'][0]
        changes=[dict(page=0,elementId=e['id'],rect=e['rect'],text='Changed serif',fontSize=18,color=e['color'],overflow=True)]
        result=run(source,dict(action='preview',page=0,edits=changes,scale=2.5,maxPixels=8000000),self.output)
        import base64
        pix=fitz.Pixmap(base64.b64decode(result['preview'].split(',',1)[1]))
        self.assertEqual((pix.width,pix.height),(1000,1500))
        run(source,dict(action='batch',page=0,edits=changes),self.output)
        with fitz.open(self.output) as edited:
            updated=next(item for item in elements(edited[0]) if item.get('text')=='Changed serif')
            self.assertEqual(updated['font'],'Times-Roman')
            for a,b in zip(updated['origin'],e['origin']):self.assertAlmostEqual(a,b,delta=.001)

    def test_overlapping_image_and_pending_redaction_are_rejected(self):
        with fitz.open(self.source) as doc:
            e=next(e for e in elements(doc[0]) if e['kind']=='image')
            doc[0].insert_image(fitz.Rect(45,165,90,210),xref=e['xref'])
            changed=self.root/'overlap.pdf';doc.save(changed)
        e=next(e for e in run(changed,{'action':'inspect','page':0},self.output)['elements'] if e['kind']=='image')
        with self.assertRaisesRegex(ValueError,'overlapping-elements'):
            run(changed,dict(action='edit',page=0,elementId=e['id'],delete=True),self.output)
        with fitz.open(self.source) as doc:
            doc[0].add_redact_annot(fitz.Rect(40,90,100,110))
            changed=self.root/'redaction.pdf';doc.save(changed)
        e=next(e for e in run(changed,{'action':'inspect','page':0},self.output)['elements'] if e['kind']=='text')
        with self.assertRaisesRegex(ValueError,'pending-redactions'):
            run(changed,dict(action='edit',page=0,elementId=e['id'],delete=True),self.output)

    def test_native_text_delete_and_replacement_image(self):
        e=self.select('text')
        run(self.source,dict(action='edit',page=0,elementId=e['id'],delete=True),self.output)
        with fitz.open(self.output) as doc:
            self.assertNotIn('Original',doc[0].get_text())
            self.assertIn('Untouched',doc[0].get_text())

if __name__=='__main__': unittest.main()
