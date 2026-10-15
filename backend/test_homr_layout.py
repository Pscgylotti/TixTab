import unittest
from types import SimpleNamespace as NS
from homr_layout import locate_symbol, normalized_rect, install_layout_hooks


class LayoutTests(unittest.TestCase):
    def test_attention_undoes_both_crops_resize_and_padding(self):
        t = dict(scale=.5, crop1=(10., 20.), crop2=(5., 10.),
                 final_x=2., final_y=2., padding_y=30., canvas_width=1280, canvas_height=256)
        self.assertEqual(locate_symbol((70, 70), t, [], 4), (100., 100., False))
        self.assertEqual(locate_symbol((71, 69), t, [((70,70), (101.,99.))], 4), (101.,99.,True))
        self.assertEqual(locate_symbol((900, 70), t, [((70,70), (101.,99.))], 4)[2], False)
        self.assertIsNone(locate_symbol((float('nan'), 70), t, [], 4))
        self.assertIsNone(locate_symbol((1300, 70), t, [], 4))

    def test_crop_offset_projects_into_original_page(self):
        r = normalized_rect(100, 50, 40, 20, 400, 200, dict(x=.1, y=.2, width=.8, height=.6))
        for key, value in dict(x=.3, y=.35, width=.08, height=.06).items():
            self.assertAlmostEqual(r[key], value)

    def test_used_staff_geometry_and_symbol_identity_survive_reordering(self):
        image = NS(shape=(200,400))
        symbols = [NS(rhythm='note_4', coordinates=(70,70)), NS(rhythm='note_4', coordinates=(170,70))]
        def original_parse(debug, index, staff, image, regions, config):
            parsing.crop_image_and_return_new_top(image)
            parsing.dewarp_staff_image(image)
            parsing.crop_image_and_return_new_top(image)
            parsing.center_image_on_canvas(NS(shape=(50,100)), (200,100))
            return symbols
        offsets = iter([(10.,20.),(5.,10.)])
        parsing = NS(parse_staff_image=original_parse, _calculate_region=lambda *a: [0,0,400,200],
                     get_tr_omr_canvas_size=lambda *a: (200,100),
                     crop_image_and_return_new_top=lambda *a: (image,next(offsets)),
                     center_image_on_canvas=lambda *a: image,
                     dewarp_staff_image=lambda *a: NS(dewarp_point=lambda p:p),
                     tr_omr_max_height=256, tr_omr_max_width=1280)
        original_crop = parsing.crop_image_and_return_new_top
        original_note = lambda *a: NS()
        generator = NS(build_note_or_rest=original_note)
        layout = install_layout_hooks(parsing, generator, dict(x=0,y=0,width=1,height=1))
        staff = NS(min_x=50, max_x=350, min_y=60, max_y=100, average_unit_size=4,
                   get_notes=lambda: [])
        parsed = parsing.parse_staff_image(None, 2, staff, image, None, None)
        self.assertIs(parsing.crop_image_and_return_new_top, original_crop)
        # Deliberately generate XML in a different order, like rhythmic voice rebalance.
        second = generator.build_note_or_rest(parsed[1])
        first = generator.build_note_or_rest(parsed[0])
        self.assertGreater(layout['noteLocations'][second.id]['region']['x'],
                           layout['noteLocations'][first.id]['region']['x'])
        self.assertEqual(len(layout['systems']),1)
        self.assertEqual(layout['noteLocations'][first.id]['system'],0)


if __name__ == '__main__':
    unittest.main()
