import unittest
from types import SimpleNamespace as Obj
from xml.etree import ElementTree as ET
from copista_layout import mapped_writer


class LayoutTests(unittest.TestCase):
    def test_maps_emission_identity_including_chords_and_restores_hook(self):
        staves = [Obj(x0=10, x1=90, y0=20, y1=40, sp=2, system=0),
                  Obj(x0=10, x1=90, y0=60, y1=80, sp=2, system=1)]
        layout = Obj(width=100, height=100, staves=staves,
                     systems=[Obj(staves=[0]), Obj(staves=[1])],
                     syms=[Obj(staff=0, box=(20, 25, 24, 29)), Obj(staff=1, box=(50, 65, 54, 69))])
        def emit(measure, event):
            ET.SubElement(measure, 'note')
        writer = Obj(_note=emit)
        measure = ET.Element('measure')
        with mapped_writer(Obj(layout=layout), writer) as mapping:
            for si in [1, 0, 1]:  # Reordered voices; same symbol copied for a split tied note.
                writer._note(measure, Obj(kind='note', si=si))
            writer._note(measure, Obj(kind='rest', si=-1))
        self.assertIs(writer._note, emit)
        self.assertEqual(len(mapping['noteLocations']), 3)
        self.assertEqual(mapping['noteLocations'][measure[0].get('id')]['system'], 1)
        self.assertEqual(mapping['noteLocations'][measure[1].get('id')]['region']['x'], .2)
        self.assertNotEqual(measure[0].get('id'), measure[2].get('id'))
        self.assertIsNone(measure[3].get('id'))
        self.assertEqual(mapping['systems'][0]['y'], .16)

    def test_restores_writer_after_failure(self):
        original = lambda *args: None
        writer = Obj(_note=original)
        layout = Obj(width=100, height=100, staves=[], systems=[], syms=[])
        with self.assertRaises(RuntimeError):
            with mapped_writer(Obj(layout=layout), writer):
                raise RuntimeError('cancelled')
        self.assertIs(writer._note, original)


if __name__ == '__main__':
    unittest.main()
