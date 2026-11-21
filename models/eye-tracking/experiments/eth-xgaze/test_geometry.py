"""Regression checks of camera normalization and 3D-to-2D conventions."""
import unittest

import cv2
import numpy as np

from bench import NORM_SIZE, POSE_LANDMARKS, camera_projection, estimated_camera, norm_and_pose


class GeometryTests(unittest.TestCase):
    def test_ray_uses_gaze_origin_when_intersecting_plane(self):
        rotation = np.eye(3)
        origin = np.array([20., 30., 600.])
        slopes, plane = camera_projection((0., .1), rotation, origin)
        np.testing.assert_allclose(slopes, [-np.tan(.1), 0.])
        np.testing.assert_allclose(plane, [20. - 600. * np.tan(.1), 30.])
        self.assertIsNone(camera_projection((0., np.pi / 2), rotation, origin))

    def test_solvepnp_and_virtual_camera_normalization(self):
        model = np.array([[-48., -30., 34.], [-18., -28., 28.], [17., -26., 29.],
                          [48., -29., 32.], [-11., 14., 21.], [12., 13., 21.]])
        camera = estimated_camera(1280, 720, 60)
        shift = np.array([17., -13., 590.])
        projected, _ = cv2.projectPoints(model, np.zeros(3), shift, camera, np.zeros(5))
        points = np.zeros((478, 2))
        points[list(POSE_LANDMARKS)] = projected.reshape(-1, 2)
        crop, view_rotation, origin = norm_and_pose(
            np.zeros((720, 1280, 3), dtype=np.uint8), points, model, camera, np.zeros(5)
        )
        self.assertEqual(crop.shape, (NORM_SIZE, NORM_SIZE, 3))
        np.testing.assert_allclose(view_rotation @ view_rotation.T, np.eye(3), atol=1e-12)
        np.testing.assert_allclose(origin, (model[:4].mean(axis=0) + model[4:].mean(axis=0)) / 2 + shift,
                                   atol=1e-7)


if __name__ == "__main__":
    unittest.main()
