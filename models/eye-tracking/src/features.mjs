export const FEATURE_NAMES = Object.freeze([
  "right_iris_x", "right_iris_y", "left_iris_x", "left_iris_y", "yaw", "pitch", "roll",
]);

export const TRACKING_OPTIONS = Object.freeze({
  numFaces: 2,
  minFaceDetectionConfidence: 0.6,
  minFacePresenceConfidence: 0.6,
  minTrackingConfidence: 0.6,
  outputFacialTransformationMatrixes: true,
});

const RIGHT_EYE = [33, 133, 159, 145, 468];
const LEFT_EYE = [362, 263, 386, 374, 473];

function eye(landmarks, indices, width, height) {
  const points = indices.map(index => landmarks[index]);
  if (points.some(point => !point || !point.every(Number.isFinite))) {
    return { reason: "missing_landmarks" };
  }

  const [outer, inner, upper, lower, iris] = points;
  const dx = (inner[0] - outer[0]) * width;
  const dy = (inner[1] - outer[1]) * height;
  const squaredWidth = dx * dx + dy * dy;
  if (squaredWidth < 7 ** 2) return { reason: "low_eye_quality" };

  // Both eye axes point toward image right, so the perpendicular points down.
  const aperture = ((lower[1] - upper[1]) * height * dx -
    (lower[0] - upper[0]) * width * dy) / squaredWidth;
  if (aperture < 0.09) return { reason: "blink" };

  const irisDx = (iris[0] - outer[0]) * width;
  const irisDy = (iris[1] - outer[1]) * height;
  const x = (irisDx * dx + irisDy * dy) / squaredWidth;
  const y = (irisDy * dx - irisDx * dy) / squaredWidth;
  if (x < 0 || x > 1 || Math.abs(y) > 0.45) return { reason: "low_eye_quality" };
  return { x, y };
}

function headPose(matrix) {
  if (matrix?.length !== 16 || !Array.from(matrix).every(Number.isFinite)) return null;
  // MediaPipe's canonical-to-observed rotation is column-major (Rz * Ry * Rx).
  const scale = Math.hypot(matrix[0], matrix[1], matrix[2]);
  if (scale < 1e-6) return null;
  const yaw = Math.asin(Math.max(-1, Math.min(1, -matrix[2] / scale)));
  const pitch = Math.atan2(matrix[6], matrix[10]);
  const roll = Math.atan2(matrix[1], matrix[0]);
  return [yaw, pitch, roll];
}

export function extractFeatures(raw, width, height) {
  if (raw.faces === 0) return { reason: "tracking_lost" };
  if (raw.faces !== 1) return { reason: "ambiguous_face" };
  if (!raw.landmarks || !Number.isFinite(width) || width <= 0 ||
      !Number.isFinite(height) || height <= 0) {
    return { reason: "missing_landmarks" };
  }

  const right = eye(raw.landmarks, RIGHT_EYE, width, height);
  const left = eye(raw.landmarks, LEFT_EYE, width, height);
  if (right.reason || left.reason) return { reason: right.reason ?? left.reason };

  const pose = headPose(raw.matrix);
  if (!pose) return { reason: "missing_pose" };
  const limits = [35, 30, 30];
  if (pose.some((angle, i) => Math.abs(angle) > limits[i] * Math.PI / 180)) {
    return { reason: "excessive_pose" };
  }
  return { features: [right.x, right.y, left.x, left.y, ...pose] };
}

export function fromMediaPipe(result) {
  const faces = result.faceLandmarks.length;
  if (faces !== 1) return { faces };
  const points = result.faceLandmarks[0];
  const landmarks = {};
  for (const index of [...RIGHT_EYE, ...LEFT_EYE]) {
    const point = points[index];
    if (point) landmarks[index] = [point.x, point.y];
  }
  const matrix = result.facialTransformationMatrixes[0]?.data;
  return { faces, landmarks, matrix };
}
