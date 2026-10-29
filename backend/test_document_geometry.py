import unittest
import numpy as np
import cv2
from document_geometry import ordered_quad, rectify, mesh_warp, projection_angle, rotate, flatten_book, lighting


class GeometryTest(unittest.TestCase):
    def image(self):
        image = np.full((600, 800, 3), 255, np.uint8)
        for y in range(70, 540, 45):
            cv2.putText(image, 'A scanned page with small print 123', (35, y), cv2.FONT_HERSHEY_SIMPLEX, .7, (0,0,0), 1)
        return image

    def test_projection_recovers_tilt_and_preserves_edges(self):
        source = self.image()
        tilted = rotate(source, 6)
        self.assertAlmostEqual(projection_angle(tilted), -6, delta=.4)
        self.assertGreater(tilted.shape[0], source.shape[0])

    def test_card_ratio_and_fold_rejection(self):
        source = self.image()
        corners = [[.1,.1],[.85,.15],[.95,.9],[.05,.8]]
        out = rectify(source, corners, 'id-landscape')
        self.assertAlmostEqual(out.shape[1]/out.shape[0], 85.6/53.98, delta=.01)
        with self.assertRaisesRegex(ValueError, 'invalid-geometry'):
            ordered_quad([[0,0],[1,1],[1,0],[0,1]])

    def test_mesh_identity_and_folds(self):
        source = self.image()
        grid = [[x/4, y/4] for y in range(5) for x in range(5)]
        out = mesh_warp(source, grid)
        self.assertLess(np.mean(abs(out.astype(float)-source)), 3)
        grid[12] = [1,1]
        with self.assertRaisesRegex(ValueError, 'invalid-geometry'):
            mesh_warp(source, grid)

    def test_flatten_abstains_on_blank_and_lighting_zero_identity(self):
        source = np.full((200,300,3),255,np.uint8)
        result, changed = flatten_book(source)
        self.assertFalse(changed)
        np.testing.assert_array_equal(result,source)
        np.testing.assert_array_equal(lighting(source,0),source)

    def test_book_curvature_is_flattened(self):
        source = np.full((600,800,3),255,np.uint8)
        xs = np.arange(35,765)
        curve = 120*((xs/799)**2-xs/799)
        for baseline in range(90,540,50):
            line = np.column_stack([xs,baseline+curve]).astype(np.int32)
            cv2.polylines(source,[line],False,(0,0,0),2)
        result,changed = flatten_book(source)
        self.assertTrue(changed)
        # Measure the first line's vertical spread after geometric correction.
        y = [np.flatnonzero(result[:120,x,0] < 100).mean() for x in range(50,750,20)]
        self.assertLess(np.std(y),2)


if __name__ == '__main__':
    unittest.main()
