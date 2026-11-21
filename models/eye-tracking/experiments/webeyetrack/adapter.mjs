import { encodePoint, normalizedPoint, predict } from "../../src/calibration.mjs";
import { gazeMessage, invalidPoint, validPoint, GazeMedianFilter } from "../../src/timeline.mjs";

export const gazeFeatures = xy => [...xy, 0, 0, 0, 0, 0];
export function project(profile, observation) {
  if (!observation || !profile) return null;
  if (profile.ridge) return predict(profile.ridge, observation);
  if (profile.affine) return profile.affine.map(([a, b, c]) => a * observation[0] + b * observation[1] + c);
  return observation.slice(0, 2);
}

export function createAdapter(sessionId, captureEpoch, geometry, profile) {
  const filter = new GazeMedianFilter();
  return (timeUs, observation) => {
    const xy = project(profile, observation);
    const point = profile && normalizedPoint(xy)
      ? validPoint(timeUs, encodePoint(xy, geometry), profile.uncertaintyRadiusPx)
      : invalidPoint(timeUs);
    return gazeMessage(sessionId, captureEpoch, filter.push(point));
  };
}
